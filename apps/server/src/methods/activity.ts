import { ACTIVITY_KINDS, activityJson } from "../activity"
import { stmt } from "../db/query"
import type { ActivityKind, ActivityRow, MessageRow, ReactionRow } from "../db/rows"
import { publish } from "../events"
import { method, type Actor, type Ctx } from "../api/context"
import { decodeCursor, encodeCursor } from "../api/args"
import { invalidArguments } from "../api/errors"
import { nowSeconds } from "../api/ids"
import { loadExtras, messageJson, reactionsOfQuery } from "../api/shapes"

// The activity inbox (docs/activity.md): list it, mark it read.

const TYPE_PREFIXES = ["channels", "groups", "im", "mpim"] as const

/** The conversation's scope prefix, as SQL over `c`. */
const TYPE_OF = `CASE c.kind WHEN 'im' THEN 'im' WHEN 'mpim' THEN 'mpim'
  ELSE CASE WHEN c.is_private THEN 'groups' ELSE 'channels' END END`

/**
 * The items a token may list, from `a`: the recipient's (?1), while they are
 * still in the conversation and the message is there, in conversation types
 * whose :history the token holds (?2, a JSON list of prefixes).
 */
const LISTABLE = `FROM activity a
  JOIN members m ON m.conversation_id = a.channel_id AND m.user_id = a.user_id
  JOIN conversations c ON c.id = a.channel_id
  JOIN messages msg ON msg.channel_id = a.channel_id AND msg.ts = a.ts AND msg.deleted = 0
    AND msg.subtype IS NOT 'tombstone'
  WHERE a.user_id = ?1 AND ${TYPE_OF} IN (SELECT value FROM json_each(?2))`

const historyTypes = (ctx: Ctx<Actor>) =>
  JSON.stringify(TYPE_PREFIXES.filter((p) => ctx.auth.scopes.includes(`${p}:history`)))

/** Unread counts by kind: `a.read = 0` lets it read only activity_unread's rows. */
export const UNREAD_COUNTS = `SELECT a.kind, COUNT(*) AS n ${LISTABLE} AND a.read = 0 GROUP BY a.kind`

/** Unread counts by kind, as a statement to batch with a read or a change. */
const unreadStatement = (ctx: Ctx<Actor>) => stmt(ctx.env.DB, UNREAD_COUNTS, ctx.auth.user.id, historyTypes(ctx))

/** Read items are kept this long, then pruned; unread ones stay until their message goes. */
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

method("campflare.activity.list", "actor", async (ctx) => {
  const limit = ctx.args.int("limit", 50, { min: 1, max: 200 })
  const cursor = decodeCursor(ctx.args.str("cursor"))
  const before = cursor === undefined ? Number.MAX_SAFE_INTEGER : itemId(cursor)
  const kinds = kindsOf(ctx)
  const db = ctx.env.DB
  // One page, newest first; its messages and their reactions, and the unread counts, in one batch.
  const page = `SELECT a.* ${LISTABLE} AND a.id < ?3 AND (?4 = 0 OR a.read = 0)
    AND (?5 IS NULL OR a.kind IN (SELECT value FROM json_each(?5))) ORDER BY a.id DESC LIMIT ?6`
  const params = [
    ctx.auth.user.id,
    historyTypes(ctx),
    before,
    ctx.args.bool("unread_only") ? 1 : 0,
    kinds ? JSON.stringify(kinds) : null,
    limit + 1,
  ]
  const [items, messages, reactions, unread] = await db.batch([
    stmt(db, page, ...params),
    stmt(db, `SELECT * FROM messages WHERE (channel_id, ts) IN (SELECT channel_id, ts FROM (${page}))`, ...params),
    reactionsOfQuery(db, page, ...params),
    unreadStatement(ctx),
  ])
  const rows = items!.results as ActivityRow[]
  const shown = rows.slice(0, limit)
  const messageRows = messages!.results as MessageRow[]
  const extras = await loadExtras(ctx.env, messageRows, reactions!.results as ReactionRow[])
  const byKey = new Map(messageRows.map((m) => [`${m.channel_id}/${m.ts}`, m]))
  return {
    items: shown.map((row) => {
      const m = byKey.get(`${row.channel_id}/${row.ts}`)
      return activityJson(row, ctx.origin, m && messageJson(m, extras, ctx.origin))
    }),
    unread: unreadFrom(unread!),
    response_metadata: { next_cursor: rows.length > limit ? encodeCursor(String(shown.at(-1)!.id)) : "" },
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
  const change = stmt(
    db,
    `UPDATE activity SET read = 1 WHERE id IN (SELECT a.id ${LISTABLE} AND a.read = 0 AND ${condition})`,
    user,
    historyTypes(ctx),
    value,
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
         SELECT id FROM activity WHERE user_id = ? AND read = 1 AND created < ? ORDER BY id LIMIT ?)`,
      user,
      nowSeconds() - READ_RETENTION_SECONDS,
      PRUNE_BATCH,
    ).run(),
  )
  return { marked: changed!.meta.changes, unread }
})
