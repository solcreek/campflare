import { requireMember, requireNotArchived, requireReadable, resolveConversation } from "../db/conversations"
import { reactionsStatement } from "../db/messages"
import { announcePin, MAX_PINS, pinCountFrom, pinCountStatement, pinItem } from "../db/pins"
import { stmt } from "../db/query"
import type { MessageRow, ReactionRow } from "../db/rows"
import { audienceFrom, audienceStatement } from "../events"
import { method, type Actor, type Ctx } from "../api/context"
import { CampflareError } from "../api/errors"
import { loadExtras, reactionsOfQuery } from "../api/shapes"

// Pins: messages pinned to the conversation they were posted in. Files are
// pinned by pinning the message that shares them; Slack's file pins are legacy.

async function pin(ctx: Ctx<Actor>, added: boolean) {
  const c = await resolveConversation(ctx, ctx.args.req("channel", "channel_not_found"))
  await requireMember(ctx, c)
  requireNotArchived(c)
  if (ctx.args.has("file") || ctx.args.has("file_comment")) throw new CampflareError("not_pinnable")
  const ts = ctx.args.ts("timestamp")
  if (!ts) throw new CampflareError("no_item_specified")
  const db = ctx.env.DB
  const now = Math.floor(Date.now() / 1000)
  // The change, the row after it, the audience, the reactions (for the event) and the new count: one round trip.
  // A message is pinnable when it exists and isn't a deleted thread head's tombstone.
  const change = added
    ? stmt(
        db,
        `UPDATE messages SET pinned_by = ?, pinned_at = ?
         WHERE channel_id = ? AND ts = ? AND deleted = 0 AND pinned_at IS NULL
           AND (subtype IS NULL OR subtype != 'tombstone')
           AND (SELECT COUNT(*) FROM messages WHERE channel_id = ?3 AND pinned_at IS NOT NULL) < ?5`,
        ctx.auth.user.id,
        now,
        c.id,
        ts,
        MAX_PINS,
      )
    : stmt(
        db,
        "UPDATE messages SET pinned_by = NULL, pinned_at = NULL WHERE channel_id = ? AND ts = ? AND pinned_at IS NOT NULL",
        c.id,
        ts,
      )
  const [before, , after, audience, reactions, count] = await db.batch([
    stmt(db, "SELECT * FROM messages WHERE channel_id = ? AND ts = ? AND deleted = 0", c.id, ts),
    change,
    stmt(db, "SELECT * FROM messages WHERE channel_id = ? AND ts = ?", c.id, ts),
    audienceStatement(db, c.id),
    reactionsStatement(db, c.id, ts),
    pinCountStatement(db, c.id),
  ])
  const was = before!.results[0] as MessageRow | undefined
  if (!was) throw new CampflareError("message_not_found")
  const pinCount = pinCountFrom(count!)
  if (added) {
    if (was.pinned_at) throw new CampflareError("already_pinned")
    if (was.subtype === "tombstone") throw new CampflareError("not_pinnable")
    // Pinnable and not pinned, yet the update didn't take: the conversation is full.
    if (!(after!.results[0] as MessageRow).pinned_at) throw new CampflareError("too_many_pins")
  } else if (!was.pinned_at) throw new CampflareError("no_pin")
  const message = added ? (after!.results[0] as MessageRow) : was
  announcePin(ctx, c, {
    added,
    message,
    extras: await loadExtras(ctx.env, [message], reactions!.results as ReactionRow[]),
    audience: audienceFrom(audience!),
    count: pinCount,
  })
  return {}
}

method("pins.add", "actor", (ctx) => pin(ctx, true))
method("pins.remove", "actor", (ctx) => pin(ctx, false))

method("pins.list", "actor", async (ctx) => {
  const c = await resolveConversation(ctx, ctx.args.req("channel", "channel_not_found"))
  await requireReadable(ctx, c)
  const db = ctx.env.DB
  const sql = "SELECT * FROM messages WHERE channel_id = ? AND pinned_at IS NOT NULL ORDER BY pinned_at DESC, ts DESC"
  // The pins and their reactions in one round trip.
  const [found, reactions] = await db.batch([stmt(db, sql, c.id), reactionsOfQuery(db, sql, c.id)])
  const rows = found!.results as MessageRow[]
  const extras = await loadExtras(ctx.env, rows, reactions!.results as ReactionRow[])
  return { items: rows.map((m) => pinItem(ctx, m, extras)) }
})
