import { encodeCursor, decodeCursor } from "../api/args"
import { all, first, run } from "../db/query"
import type { ConversationRow, MemberRow, UserRow } from "../db/rows"
import { conversationJson, presenceOf, userJson } from "../api/shapes"
import { method, type Actor, type Ctx } from "../api/context"
import { CampflareError } from "../api/errors"
import { imPeer } from "../db/conversations"
import { nowSeconds } from "../api/ids"

export async function getUser(ctx: Ctx<Actor>, id: string) {
  const user = await first<UserRow>(
    ctx.env.DB,
    "SELECT * FROM users WHERE id = ? AND team_id = ?",
    id,
    ctx.auth.team.id,
  )
  if (!user) throw new CampflareError("user_not_found")
  return user
}

method("users.info", "actor", async (ctx) => {
  const user = await getUser(ctx, ctx.args.req("user", "user_not_found"))
  return { user: userJson(user, ctx.origin) }
})

method("users.list", "actor", async (ctx) => {
  const limit = ctx.args.int("limit", 0, { min: 0, max: 1000 }) || 1000
  const after = decodeCursor(ctx.args.str("cursor")) ?? ""
  const rows = await all<UserRow>(
    ctx.env.DB,
    "SELECT * FROM users WHERE team_id = ? AND id > ? ORDER BY id LIMIT ?",
    ctx.auth.team.id,
    after,
    limit + 1,
  )
  const page = rows.slice(0, limit)
  return {
    members: page.map((u) => userJson(u, ctx.origin)),
    cache_ts: nowSeconds(),
    response_metadata: { next_cursor: rows.length > limit ? encodeCursor(page.at(-1)!.id) : "" },
  }
})

method("users.lookupByEmail", "actor", async (ctx) => {
  const user = await first<UserRow>(
    ctx.env.DB,
    "SELECT * FROM users WHERE team_id = ? AND email = ? AND deleted = 0",
    ctx.auth.team.id,
    ctx.args.req("email").toLowerCase(),
  )
  if (!user) throw new CampflareError("users_not_found")
  return { user: userJson(user, ctx.origin) }
})

method("users.getPresence", "actor", async (ctx) => {
  const user = ctx.args.has("user") ? await getUser(ctx, ctx.args.req("user")) : ctx.auth.user
  const hub = ctx.env.HUB.get(ctx.env.HUB.idFromName(ctx.auth.team.id))
  // A live RTM connection counts as active, as a Slack client does; else recent API use.
  const online = user.manual_presence !== "away" && (await hub.online([user.id])).length > 0
  const presence = online ? "active" : presenceOf(user)
  return {
    presence,
    ...(user.id === ctx.auth.user.id
      ? {
          online: presence === "active",
          auto_away: false,
          manual_away: user.manual_presence === "away",
          connection_count: 0,
          last_activity: user.last_activity,
        }
      : {}),
  }
})

method("users.setPresence", "user", async (ctx) => {
  const presence = ctx.args.req("presence")
  if (presence !== "auto" && presence !== "away") throw new CampflareError("invalid_presence")
  await run(ctx.env.DB, "UPDATE users SET manual_presence = ? WHERE id = ?", presence, ctx.auth.user.id)
  return {}
})

method("users.profile.get", "actor", async (ctx) => {
  const user = ctx.args.has("user") ? await getUser(ctx, ctx.args.req("user")) : ctx.auth.user
  return { profile: userJson(user, ctx.origin).profile }
})

const PROFILE_FIELDS: Record<string, keyof UserRow> = {
  real_name: "real_name",
  display_name: "display_name",
  title: "title",
  status_text: "status_text",
  status_emoji: "status_emoji",
  status_expiration: "status_expiration",
}

method("users.profile.set", "user", async (ctx) => {
  const changes: Record<string, unknown> = { ...ctx.args.json<Record<string, unknown>>("profile") }
  const name = ctx.args.str("name")
  if (name) changes[name] = ctx.args.str("value") ?? ""
  const sets = Object.entries(changes).filter(([k]) => k in PROFILE_FIELDS)
  if (sets.length === 0) throw new CampflareError("invalid_profile")
  await run(
    ctx.env.DB,
    `UPDATE users SET ${sets.map(([k]) => `${PROFILE_FIELDS[k]} = ?`).join(", ")}, updated = ? WHERE id = ?`,
    ...sets.map(([, v]) => (typeof v === "number" ? v : String(v ?? ""))),
    nowSeconds(),
    ctx.auth.user.id,
  )
  const user = await getUser(ctx, ctx.auth.user.id)
  return { profile: userJson(user, ctx.origin).profile }
})

const TYPE_FILTERS: Record<string, string> = {
  public_channel: "(c.kind = 'channel' AND c.is_private = 0)",
  private_channel: "(c.kind = 'channel' AND c.is_private = 1)",
  mpim: "c.kind = 'mpim'",
  im: "c.kind = 'im'",
}

/** The SQL filter for a `types` argument (default: public channels, as Slack). */
export function typesFilter(types: string[]): string {
  const filters = (types.length ? types : ["public_channel"]).map((t) => {
    const f = TYPE_FILTERS[t]
    if (!f) throw new CampflareError("invalid_types")
    return f
  })
  return `(${filters.join(" OR ")})`
}

method("users.conversations", "actor", async (ctx) => {
  const user = ctx.args.has("user") ? await getUser(ctx, ctx.args.req("user")) : ctx.auth.user
  const limit = ctx.args.int("limit", 100, { min: 1, max: 999 })
  const after = decodeCursor(ctx.args.str("cursor")) ?? ""
  const archived = ctx.args.bool("exclude_archived") ? "AND c.is_archived = 0" : ""
  const rows = await all<ConversationRow & Pick<MemberRow, "last_read">>(
    ctx.env.DB,
    `SELECT c.*, m.last_read FROM members m JOIN conversations c ON c.id = m.conversation_id
     WHERE m.user_id = ? AND c.team_id = ? AND c.id > ? AND ${typesFilter(ctx.args.list("types"))} ${archived}
     ORDER BY c.id LIMIT ?`,
    user.id,
    ctx.auth.team.id,
    after,
    limit + 1,
  )
  const page = rows.slice(0, limit)
  const self = user.id === ctx.auth.user.id
  return {
    channels: page.map((c) =>
      conversationJson(c, {
        member: self ? { last_read: c.last_read } : { last_read: "" },
        imUser: imPeer(c, user.id),
      }),
    ),
    response_metadata: { next_cursor: rows.length > limit ? encodeCursor(page.at(-1)!.id) : "" },
  }
})
