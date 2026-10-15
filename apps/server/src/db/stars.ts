import { stmt } from "./query"
import type { StarRow } from "./rows"

// Saved items (stars, migration 0022): one row per person and item.

/** Forgets every person's star on a message, as a statement to batch with its deletion. */
export const unsaveStatement = (db: D1Database, channelId: string, ts: string) =>
  stmt(db, "DELETE FROM stars WHERE type = 'message' AND channel_id = ? AND ts = ?", channelId, ts)

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
