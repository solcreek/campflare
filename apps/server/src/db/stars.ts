import { stmt } from "./query"

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
