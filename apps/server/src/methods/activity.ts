import { ACTIVITY_KINDS, activityJson } from "../activity"
import { stmt } from "../db/query"
import type { ActivityKind, ActivityRow, MessageRow, ReactionRow } from "../db/rows"
import { publish } from "../events"
import { method, type Actor, type Ctx } from "../api/context"
import { decodeCursor, encodeCursor } from "../api/args"
import { invalidArguments } from "../api/errors"
import { nowSeconds } from "../api/ids"
import { loadExtras, messageJson } from "../api/shapes"

// The activity inbox (docs/activity.md): list it, mark it read.

const TYPE_PREFIXES = ["channels", "groups", "im", "mpim"] as const

/** The conversation's scope prefix, as SQL over `c`. */
const TYPE_OF = `CASE c.kind WHEN 'im' THEN 'im' WHEN 'mpim' THEN 'mpim'
  ELSE CASE WHEN c.is_private THEN 'groups' ELSE 'channels' END END`

/**
 * The items a token may list, from `a`: the recipient's (?1), while they are
 * still in the conversation, in conversation types whose :history the token
 * holds (?2, a JSON list of prefixes). A token holding every type's (`all`)
 * needs no look at the conversation. With `message`, its message too (`msg`).
 * Without it, items are trusted to be there only while their message is:
 * deleting or tombstoning a message deletes its items in the same batch.
 */
export function visible({ all, message = false }: { all: boolean; message?: boolean }) {
  return `FROM activity a
  JOIN members m ON m.conversation_id = a.channel_id AND m.user_id = a.user_id
  ${all ? "" : "JOIN conversations c ON c.id = a.channel_id"}
  ${message ? "JOIN messages msg ON msg.channel_id = a.channel_id AND msg.ts = a.ts AND msg.deleted = 0 AND msg.subtype IS NOT 'tombstone'" : ""}
  WHERE a.user_id = ?1 AND ${all ? "?2 IS NOT NULL" : `${TYPE_OF} IN (SELECT value FROM json_each(?2))`}`
}

/** The type prefixes whose :history the token holds, and whether that's all of them. */
function historyTypes(ctx: Ctx<Actor>) {
  const types = TYPE_PREFIXES.filter((p) => ctx.auth.scopes.includes(`${p}:history`))
  return { json: JSON.stringify(types), all: types.length === TYPE_PREFIXES.length }
}

/** Unread counts by kind: `a.read = 0` lets it read only activity_unread's rows, and a member lookup each. */
export const unreadCounts = (all: boolean) =>
  `SELECT a.kind, COUNT(*) AS n ${visible({ all })} AND a.read = 0 GROUP BY a.kind`

/** Unread counts by kind, as a statement to batch with a read or a change. */
const unreadStatement = (ctx: Ctx<Actor>) => {
  const types = historyTypes(ctx)
  return stmt(ctx.env.DB, unreadCounts(types.all), ctx.auth.user.id, types.json)
}

/** Read items are kept this long after they were read, then pruned; unread ones stay until their message goes. */
export const READ_RETENTION_SECONDS = 90 * 24 * 60 * 60

/** Read items pruned per mark, at most: a bounded delete, after the response. */
const PRUNE_BATCH = 100

/** The unread counts from an unreadStatement's result: every kind, and the total. */
function unreadFrom(result: D1Result) {
  const counts: Record<string, number> = { total: 0, ...Object.fromEntries(ACTIVITY_KINDS.map((k) => [k, 0])) }
  for (const { kind, n } of result.results as { kind: ActivityKind; n: number }[]) {
    counts[kind] = n
    counts.total! += n
  }
  return counts
}

function kindsOf(ctx: Ctx<Actor>): ActivityKind[] | undefined {
  const types = ctx.args.list("types")
  if (types.length === 0) return undefined
  const unknown = types.filter((t) => !ACTIVITY_KINDS.includes(t as ActivityKind))
  if (unknown.length) throw invalidArguments(`unknown activity types: ${unknown.join(", ")}`)
  return types as ActivityKind[]
}

/** An item id as given: a positive integer. */
function itemId(raw: string): number {
  if (!/^\d+$/.test(raw)) throw invalidArguments(`not an activity id: ${raw}`)
  return Number(raw)
}

/** A row of a listed page: the item's own fields (a_*), then its message's. */
type PageRow = MessageRow & {
  a_id: number
  a_kind: ActivityKind
  a_thread_ts: string | null
  a_actor_id: string
  a_reaction: string
  a_created: number
  a_notify: number
  a_read: number
  a_reactions: string
}

const itemOf = (r: PageRow, user: string): ActivityRow => ({
  id: r.a_id,
  team_id: r.team_id,
  user_id: user,
  kind: r.a_kind,
  channel_id: r.channel_id,
  ts: r.ts,
  thread_ts: r.a_thread_ts,
  actor_id: r.a_actor_id,
  reaction: r.a_reaction,
  created: r.a_created,
  notify: r.a_notify,
  read: r.a_read,
})

method("campflare.activity.list", "actor", async (ctx) => {
  const limit = ctx.args.int("limit", 50, { min: 1, max: 200 })
  const cursor = decodeCursor(ctx.args.str("cursor"))
  const before = cursor === undefined ? Number.MAX_SAFE_INTEGER : itemId(cursor)
  const kinds = kindsOf(ctx)
  const db = ctx.env.DB
  const types = historyTypes(ctx)
  // The page is computed once: each row is the item (a_*), its message (msg.*) and the message's
  // reactions as JSON. The unread counts come in the same batch: one round trip.
  const page = stmt(
    db,
    `SELECT a.id AS a_id, a.kind AS a_kind, a.thread_ts AS a_thread_ts, a.actor_id AS a_actor_id,
       a.reaction AS a_reaction, a.created AS a_created, a.notify AS a_notify, a.read AS a_read, msg.*,
       (SELECT json_group_array(json_object('channel_id', r.channel_id, 'ts', r.ts, 'name', r.name,
          'user_id', r.user_id, 'created', r.created))
        FROM reactions r WHERE r.channel_id = msg.channel_id AND r.ts = msg.ts) AS a_reactions
     ${visible({ all: types.all, message: true })} AND a.id < ?3 AND (?4 = 0 OR a.read = 0)
       AND (?5 IS NULL OR a.kind IN (SELECT value FROM json_each(?5)))
     ORDER BY a.id DESC LIMIT ?6`,
    ctx.auth.user.id,
    types.json,
    before,
    ctx.args.bool("unread_only") ? 1 : 0,
    kinds ? JSON.stringify(kinds) : null,
    limit + 1,
  )
  const [items, unread] = await db.batch([page, unreadStatement(ctx)])
  const rows = items!.results as PageRow[]
  const shown = rows.slice(0, limit)
  // Files and bot apps, if any, for the shown rows only; reactions are in hand.
  const reactions = shown
    .flatMap((r) => JSON.parse(r.a_reactions) as ReactionRow[])
    .toSorted((x, y) => x.created - y.created)
  const extras = await loadExtras(ctx.env, shown, reactions)
  return {
    items: shown.map((r) => activityJson(itemOf(r, ctx.auth.user.id), ctx.origin, messageJson(r, extras, ctx.origin))),
    unread: unreadFrom(unread!),
    response_metadata: { next_cursor: rows.length > limit ? encodeCursor(String(shown.at(-1)!.a_id)) : "" },
  }
})

method("campflare.activity.mark", "actor", async (ctx) => {
  const ids = ctx.args.list("ids")
  const upTo = ctx.args.str("up_to")
  const everything = ctx.args.bool("all")
  const given = [ids.length > 0, upTo !== undefined, everything].filter(Boolean).length
  if (given !== 1) throw invalidArguments("give exactly one of ids, up_to or all")
  const user = ctx.auth.user.id
  const db = ctx.env.DB
  // Only what the token can list, so `marked` is what leaves the unread counts.
  const [condition, value]: [string, unknown] =
    ids.length > 0
      ? ["a.id IN (SELECT value FROM json_each(?3))", JSON.stringify(ids.map(itemId))]
      : upTo !== undefined
        ? ["a.id <= ?3", itemId(upTo)]
        : ["?3 IS NULL", null]
  const types = historyTypes(ctx)
  const change = stmt(
    db,
    `UPDATE activity SET read = ?4 WHERE id IN (SELECT a.id ${visible(types)} AND a.read = 0 AND ${condition})`,
    user,
    types.json,
    value,
    nowSeconds(),
  )
  const [changed, counts] = await db.batch([change, unreadStatement(ctx)])
  const unread = unreadFrom(counts!)
  // Every client of the person clears the same badge.
  publish(ctx, {
    teamId: ctx.auth.team.id,
    audience: [user],
    rtmOnly: true,
    event: {
      type: "activity_marked",
      ...(ids.length > 0 ? { ids } : upTo !== undefined ? { up_to: upTo } : { all: true }),
      unread,
    },
  })
  // Now and then is enough: a mark is when items turn read.
  ctx.waitUntil(
    stmt(
      db,
      `DELETE FROM activity WHERE id IN (
         SELECT id FROM activity WHERE user_id = ? AND read > 0 AND read < ? ORDER BY id LIMIT ?)`,
      user,
      nowSeconds() - READ_RETENTION_SECONDS,
      PRUNE_BATCH,
    ).run(),
  )
  return { marked: changed!.meta.changes, unread }
})
