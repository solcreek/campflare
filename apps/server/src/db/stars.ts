import type { Ctx } from "../api/context"
import { publish } from "../events"
import { stmt } from "./query"
import type { StarRow } from "./rows"

// Saved items (stars, migration 0022): one row per person and item.

/** Forgets every person's star on a message, as a statement to batch with its deletion: announceUnsaved() takes its result. */
export const unsaveStatement = (db: D1Database, channelId: string, ts: string) =>
  stmt(db, "DELETE FROM stars WHERE type = 'message' AND channel_id = ? AND ts = ? RETURNING *", channelId, ts)

/** The same for a file. */
export const unsaveFileStatement = (db: D1Database, fileId: string) =>
  stmt(db, "DELETE FROM stars WHERE type = 'file' AND file_id = ? RETURNING *", fileId)

/** star_removed to each person whose star a deletion took (an unsave statement's result). */
export function announceUnsaved(ctx: Pick<Ctx, "env" | "waitUntil">, teamId: string, removed: D1Result) {
  const eventTs = `${(Date.now() / 1000).toFixed(6)}`
  for (const s of removed.results as StarRow[]) {
    publish(ctx, {
      teamId,
      audience: [s.user_id],
      event: { type: "star_removed", user: s.user_id, item: unstarredItem(s), event_ts: eventTs },
    })
  }
}

/** The key a star is stored under. */
export const starKey = {
  message: (channelId: string, ts: string) => `message:${channelId}/${ts}`,
  file: (fileId: string) => `file:${fileId}`,
  channel: (channelId: string) => `channel:${channelId}`,
}

/**
 * A removed star's item for star_removed: what the row itself says, with
 * is_starred false. Nothing more is read, so it reveals nothing the person
 * may no longer see. `type` names a conversation star's kind (channel, group, im).
 */
export function unstarredItem(
  s: Pick<StarRow, "type" | "channel_id" | "ts" | "file_id" | "created">,
  type = "channel",
) {
  if (s.type === "message") {
    return { type: "message", channel: s.channel_id, message: { ts: s.ts, is_starred: false }, date_create: s.created }
  }
  if (s.type === "file") return { type: "file", file: { id: s.file_id, is_starred: false }, date_create: s.created }
  return { type, channel: s.channel_id, date_create: s.created }
}
