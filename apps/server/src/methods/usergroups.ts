import { first, stmt } from "../db/query"
import type { UsergroupRow } from "../db/rows"
import { GROUPS_WITH_MEMBERS, type UsergroupWithMembers } from "../db/usergroups"
import { method, type Actor, type Ctx } from "../api/context"
import { CampflareError, invalidArguments } from "../api/errors"
import { ids, nowSeconds } from "../api/ids"
import { usergroupJson } from "../api/shapes"
import { publish } from "../events"

// User groups (Slack's usergroups.*): a handle people mention as @handle, a
// name, a description, default channels and members. Anyone in the workspace
// may create, edit, fill, disable and enable any group, as on Slack by default;
// the token's usergroups:write scope is the gate (not in the `write` preset: a
// chat agent rarely needs to change who @oncall reaches). Disabled groups keep
// their handle. Handles share a namespace with people's names (migration 0021).

const HANDLE = /^[a-z0-9][a-z0-9._-]{0,79}$/
/** Mentions that already mean something: <!here>, <!channel>, <!everyone>. */
const RESERVED = new Set(["here", "channel", "everyone"])

function handleArg(raw: string): string {
  const handle = raw.replace(/^@/, "").toLowerCase()
  if (!HANDLE.test(handle) || RESERVED.has(handle)) throw new CampflareError("invalid_handle")
  return handle
}

/** A handle from a name when none is given: "Design Team" → "design-team", "Équipe" → "equipe". */
function handleFromName(name: string): string {
  const handle = name
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    // Cut to length first, so the cut can't leave a separator at the end.
    .slice(0, 80)
    .replace(/^[-._]+|[-._]+$/g, "")
  if (!handle) throw invalidArguments("handle is required when the name has no Latin letters or digits")
  return handleArg(handle)
}

function nameArg(raw: string): string {
  const name = raw.trim()
  if (!name || name.length > 255) throw new CampflareError("invalid_name")
  return name
}

/** `channels` as stored JSON: public channels of this workspace, checked. Undefined when not given. */
async function channelsArg(ctx: Ctx<Actor>): Promise<string | undefined> {
  if (!ctx.args.given("channels")) return undefined
  const channels = [...new Set(ctx.args.list("channels"))]
  if (channels.length === 0) return "[]"
  const found = await first<{ n: number }>(
    ctx.env.DB,
    `SELECT count(*) AS n FROM conversations WHERE team_id = ? AND kind = 'channel' AND is_private = 0
     AND id IN (SELECT value FROM json_each(?))`,
    ctx.auth.team.id,
    JSON.stringify(channels),
  )
  if (found?.n !== channels.length) throw new CampflareError("invalid_channel")
  return JSON.stringify(channels)
}

/** A write refused by the handle or name indexes, or the people-name trigger, as Slack's codes. */
function clash(error: unknown): never {
  const message = error instanceof Error ? error.message : ""
  if (message.includes("handle_taken_by_user") || message.includes("usergroups.handle")) {
    throw new CampflareError("handle_already_exists")
  }
  if (message.includes("usergroups.name")) throw new CampflareError("name_already_exists")
  throw error
}

const membersOf = (g: UsergroupWithMembers) => (JSON.parse(g.members) as string[]).toSorted()

const groupStatement = (ctx: Ctx<Actor>, id: string) =>
  stmt(ctx.env.DB, `${GROUPS_WITH_MEMBERS} WHERE g.id = ? AND g.team_id = ?`, id, ctx.auth.team.id)

async function getGroup(ctx: Ctx<Actor>, id: string): Promise<UsergroupWithMembers> {
  const group = await groupStatement(ctx, id).first<UsergroupWithMembers>()
  if (!group) throw new CampflareError("no_such_subteam")
  return group
}

function announce(ctx: Ctx<Actor>, type: string, json: ReturnType<typeof usergroupJson>) {
  publish(ctx, { teamId: ctx.auth.team.id, audience: "team", event: { type, subteam: json } })
}

/** Runs an UPDATE … RETURNING on a group and reads it back with its members, in one trip. */
async function updateGroup(ctx: Ctx<Actor>, id: string, sets: string, ...params: unknown[]) {
  let results: D1Result[]
  try {
    results = await ctx.env.DB.batch([
      stmt(
        ctx.env.DB,
        `UPDATE usergroups SET ${sets}, date_update = ?, updated_by = ? WHERE id = ? AND team_id = ? RETURNING id`,
        ...params,
        nowSeconds(),
        ctx.auth.user.id,
        id,
        ctx.auth.team.id,
      ),
      groupStatement(ctx, id),
    ])
  } catch (error) {
    clash(error)
  }
  const group = results[1]!.results[0] as UsergroupWithMembers | undefined
  if (!results[0]!.results.length || !group) throw new CampflareError("no_such_subteam")
  return group
}

method("usergroups.create", "actor", async (ctx) => {
  const name = nameArg(ctx.args.req("name"))
  const handle = ctx.args.has("handle") ? handleArg(ctx.args.req("handle")) : handleFromName(name)
  const channels = (await channelsArg(ctx)) ?? "[]"
  const now = nowSeconds()
  const row: UsergroupRow = {
    id: ids.usergroup(),
    team_id: ctx.auth.team.id,
    handle,
    name,
    description: ctx.args.str("description") ?? "",
    channels,
    created_by: ctx.auth.user.id,
    updated_by: ctx.auth.user.id,
    deleted_by: null,
    date_create: now,
    date_update: now,
    date_delete: 0,
  }
  try {
    await stmt(
      ctx.env.DB,
      `INSERT INTO usergroups (id, team_id, handle, name, description, channels, created_by, updated_by, date_create, date_update)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      row.id,
      row.team_id,
      row.handle,
      row.name,
      row.description,
      row.channels,
      row.created_by,
      row.updated_by,
      now,
      now,
    ).run()
  } catch (error) {
    clash(error)
  }
  const json = usergroupJson(row, [])
  announce(ctx, "subteam_created", json)
  return { usergroup: json }
})

method("usergroups.list", "actor", async (ctx) => {
  const disabled = ctx.args.bool("include_disabled") ? "" : "AND g.date_delete = 0"
  const users = ctx.args.bool("include_users")
  const { results } = await stmt(
    ctx.env.DB,
    `${GROUPS_WITH_MEMBERS} WHERE g.team_id = ? ${disabled} ORDER BY g.name COLLATE NOCASE`,
    ctx.auth.team.id,
  ).all<UsergroupWithMembers>()
  return { usergroups: results.map((g) => usergroupJson(g, membersOf(g), { users })) }
})

method("usergroups.update", "actor", async (ctx) => {
  const id = ctx.args.req("usergroup", "no_such_subteam")
  const sets: string[] = []
  const params: unknown[] = []
  const set = (column: string, value: unknown) => {
    sets.push(`${column} = ?`)
    params.push(value)
  }
  if (ctx.args.has("name")) set("name", nameArg(ctx.args.req("name")))
  if (ctx.args.has("handle")) set("handle", handleArg(ctx.args.req("handle")))
  if (ctx.args.given("description")) set("description", ctx.args.str("description") ?? "")
  const channels = await channelsArg(ctx)
  if (channels !== undefined) set("channels", channels)
  const group = sets.length ? await updateGroup(ctx, id, sets.join(", "), ...params) : await getGroup(ctx, id)
  const json = usergroupJson(group, membersOf(group))
  if (sets.length) announce(ctx, "subteam_updated", json)
  return { usergroup: json }
})

/**
 * Disables or enables a group: one UPDATE guarded on the current state, read back in the same
 * batch. One already so is answered as it is, with no event; of two concurrent calls, only
 * the one whose UPDATE changed the row announces it.
 */
async function setEnabled(ctx: Ctx<Actor>, enabled: boolean) {
  const id = ctx.args.req("usergroup", "no_such_subteam")
  const now = nowSeconds()
  const [changed, read] = await ctx.env.DB.batch([
    enabled
      ? stmt(
          ctx.env.DB,
          `UPDATE usergroups SET date_delete = 0, deleted_by = NULL, date_update = ?, updated_by = ?
           WHERE id = ? AND team_id = ? AND date_delete != 0 RETURNING id`,
          now,
          ctx.auth.user.id,
          id,
          ctx.auth.team.id,
        )
      : stmt(
          ctx.env.DB,
          `UPDATE usergroups SET date_delete = ?, deleted_by = ?, date_update = ?, updated_by = ?
           WHERE id = ? AND team_id = ? AND date_delete = 0 RETURNING id`,
          now,
          ctx.auth.user.id,
          now,
          ctx.auth.user.id,
          id,
          ctx.auth.team.id,
        ),
    groupStatement(ctx, id),
  ])
  const group = read!.results[0] as UsergroupWithMembers | undefined
  if (!group) throw new CampflareError("no_such_subteam")
  const json = usergroupJson(group, membersOf(group))
  if (changed!.results.length) announce(ctx, "subteam_updated", json)
  return { usergroup: json }
}

method("usergroups.disable", "actor", (ctx) => setEnabled(ctx, false))
method("usergroups.enable", "actor", (ctx) => setEnabled(ctx, true))

method("usergroups.users.list", "actor", async (ctx) => {
  const group = await getGroup(ctx, ctx.args.req("usergroup", "no_such_subteam"))
  if (group.date_delete && !ctx.args.bool("include_disabled")) throw new CampflareError("no_such_subteam")
  return { users: membersOf(group) }
})

/**
 * Replaces a group's members with `users` (people of this workspace; not apps'
 * bot users; at least one, as on Slack). Slack's events follow: subteam_updated and subteam_members_changed
 * to everyone, subteam_self_added / _removed to those added and removed.
 */
method("usergroups.users.update", "actor", async (ctx) => {
  const id = ctx.args.req("usergroup", "no_such_subteam")
  const wanted = [...new Set(ctx.args.list("users"))]
  // As Slack: a group keeps at least one member; disable it instead of emptying it.
  if (wanted.length === 0) throw new CampflareError("no_users_provided")
  const db = ctx.env.DB
  const [found, valid] = await db.batch([
    groupStatement(ctx, id),
    stmt(
      db,
      `SELECT id FROM users WHERE team_id = ? AND deleted = 0 AND is_bot = 0 AND id IN (SELECT value FROM json_each(?))`,
      ctx.auth.team.id,
      JSON.stringify(wanted),
    ),
  ])
  const before = found!.results[0] as UsergroupWithMembers | undefined
  if (!before) throw new CampflareError("no_such_subteam")
  if (valid!.results.length !== wanted.length) throw new CampflareError("invalid_users")
  const list = JSON.stringify(wanted)
  const now = nowSeconds()
  // The members before, the change and the result in one transaction, so the
  // events describe exactly this change even when two run at once.
  const [old, , , , after] = await db.batch([
    // Active members only, as the group's users and user_count count them: a deactivated
    // member's row goes quietly with the DELETE, never reported as removed.
    stmt(
      db,
      `SELECT m.user_id FROM usergroup_members m JOIN users u ON u.id = m.user_id AND u.deleted = 0
       WHERE m.usergroup_id = ?`,
      id,
    ),
    stmt(
      db,
      "DELETE FROM usergroup_members WHERE usergroup_id = ? AND user_id NOT IN (SELECT value FROM json_each(?))",
      id,
      list,
    ),
    stmt(
      db,
      "INSERT OR IGNORE INTO usergroup_members (usergroup_id, user_id) SELECT ?, value FROM json_each(?)",
      id,
      list,
    ),
    stmt(db, "UPDATE usergroups SET date_update = ?, updated_by = ? WHERE id = ?", now, ctx.auth.user.id, id),
    groupStatement(ctx, id),
  ])
  const previous = new Set((old!.results as { user_id: string }[]).map((r) => r.user_id))
  const added = wanted.filter((u) => !previous.has(u))
  const removed = [...previous].filter((u) => !wanted.includes(u))
  const group = after!.results[0] as UsergroupWithMembers
  const json = usergroupJson(group, membersOf(group))
  announce(ctx, "subteam_updated", json)
  if (added.length || removed.length) {
    const teamId = ctx.auth.team.id
    publish(ctx, {
      teamId,
      audience: "team",
      event: {
        type: "subteam_members_changed",
        subteam_id: id,
        team_id: teamId,
        date_previous_update: before.date_update,
        date_update: now,
        added_users: added,
        // Strings, as Slack sends them.
        added_users_count: String(added.length),
        removed_users: removed,
        removed_users_count: String(removed.length),
      },
    })
    if (added.length) publish(ctx, { teamId, audience: added, event: { type: "subteam_self_added", subteam_id: id } })
    if (removed.length) {
      publish(ctx, { teamId, audience: removed, event: { type: "subteam_self_removed", subteam_id: id } })
    }
  }
  return { usergroup: json }
})
