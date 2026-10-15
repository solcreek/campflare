import { publish } from "../events"
import type { Actor, Ctx } from "../api/context"
import { messageJson, permalink, type MessageExtras } from "../api/shapes"
import type { ConversationRow, MessageRow } from "./rows"

// Pins live on the message (migration 0022): pinned_by and pinned_at.

/** A conversation's pins can't grow past this, as on Slack (too_many_pins). */
export const MAX_PINS = 100

/** The number of pins in a conversation, as a statement to batch with a change. */
export const pinCountStatement = (db: D1Database, channelId: string) =>
  db.prepare("SELECT COUNT(*) AS n FROM messages WHERE channel_id = ? AND pinned_at IS NOT NULL").bind(channelId)

export const pinCountFrom = (result: D1Result) => (result.results[0] as { n: number }).n

/** A pinned message (a row with pinned_by and pinned_at) as pins.list and the pin events carry it. */
export function pinItem(ctx: Pick<Ctx, "origin">, m: MessageRow, extras: MessageExtras) {
  return {
    type: "message",
    channel: m.channel_id,
    created: m.pinned_at!,
    created_by: m.pinned_by!,
    message: {
      ...messageJson(m, extras, ctx.origin),
      permalink: permalink(ctx.origin, m.channel_id, m.ts, m.thread_ts),
    },
  }
}

/**
 * pin_added or pin_removed, in Slack's shape, to the conversation's members.
 * `message` is the row while pinned: after pinning, or from before unpinning.
 */
export function announcePin(
  ctx: Ctx<Actor>,
  c: ConversationRow,
  change: { added: boolean; message: MessageRow; extras: MessageExtras; audience: string[]; count: number },
) {
  const { added, message: m, extras, audience, count } = change
  publish(ctx, {
    teamId: c.team_id,
    audience,
    event: {
      type: added ? "pin_added" : "pin_removed",
      user: ctx.auth.user.id,
      channel_id: c.id,
      item: pinItem(ctx, m, extras),
      ...(m.user_id ? { item_user: m.user_id } : {}),
      pin_count: String(count),
      pinned_info: { channel: c.id, pinned_by: m.pinned_by!, pinned_ts: m.pinned_at! },
      ...(added ? {} : { has_pins: count > 0 }),
      event_ts: `${(Date.now() / 1000).toFixed(6)}`,
    },
  })
}
