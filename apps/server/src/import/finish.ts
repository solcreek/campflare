import type { Actor, Ctx } from "../api/context"
import { nowSeconds } from "../api/ids"
import { all, first, stmt } from "../db/query"
import { jobJson, loadJob, type ImportJobRow } from "./job"
import { recountThreads } from "./messages"
import { SYSTEM_USER_ID } from "./text"

// campflare.import.finish: the per-conversation work after the messages are
// in, a few conversations per call (docs/import.md, Finish).

/** Conversations handled per call: each is six statements of one batch. */
export const FINISH_PER_CALL = 10

export async function finishImport(ctx: Ctx<Actor>) {
  const job = await loadJob(ctx, { running: true })
  const db = ctx.env.DB
  const pending = await all<{ conversation_id: string }>(
    db,
    `SELECT DISTINCT conversation_id FROM import_conversations WHERE job_id = ? AND finished = 0
     ORDER BY conversation_id LIMIT ?`,
    job.id,
    FINISH_PER_CALL,
  )
  const now = nowSeconds()
  const done = JSON.stringify(pending.map((p) => p.conversation_id))
  const results = await db.batch([
    ...pending.flatMap(({ conversation_id: id }) => finishConversation(db, job, id)),
    stmt(
      db,
      `UPDATE import_conversations SET finished = 1
       WHERE job_id = ? AND conversation_id IN (SELECT value FROM json_each(?))`,
      job.id,
      done,
    ),
    // The last call finishes the job.
    stmt(
      db,
      `UPDATE import_jobs SET state = 'finished', finished = ?, updated = ?
       WHERE id = ? AND state = 'running'
         AND NOT EXISTS (SELECT 1 FROM import_conversations WHERE job_id = ? AND finished = 0)`,
      now,
      now,
      job.id,
      job.id,
    ),
    stmt(db, "SELECT count(*) AS n FROM import_conversations WHERE job_id = ? AND finished = 0", job.id),
  ])
  const remaining = (results.at(-1)!.results[0] as { n: number }).n
  const after = (await first<ImportJobRow>(db, "SELECT * FROM import_jobs WHERE id = ?", job.id))!
  return { done: remaining === 0, remaining, job: jobJson(after) }
}

function finishConversation(db: D1Database, job: ImportJobRow, id: string): D1PreparedStatement[] {
  const replies = "channel_id = ?1 AND import_job = ?2 AND thread_ts IS NOT NULL AND thread_ts <> ts"
  const newest = "(SELECT max(ts) FROM messages WHERE channel_id = ?1 AND import_job = ?2)"
  return [
    // A thread whose head isn't in the export (Slack drops deleted heads): a tombstone head, as chat.delete leaves.
    stmt(
      db,
      `INSERT OR IGNORE INTO messages (channel_id, ts, team_id, user_id, subtype, text, thread_ts, import_job)
       SELECT DISTINCT r.channel_id, r.thread_ts, r.team_id, '${SYSTEM_USER_ID}', 'tombstone', 'This message was deleted.',
         r.thread_ts, ?2
       FROM messages r
       WHERE r.channel_id = ?1 AND r.import_job = ?2 AND r.thread_ts IS NOT NULL AND r.thread_ts <> r.ts
         AND NOT EXISTS (SELECT 1 FROM messages h WHERE h.channel_id = r.channel_id AND h.ts = r.thread_ts)`,
      id,
      job.id,
    ),
    recountThreads(db, id, job.id, {
      sql: "SELECT DISTINCT thread_ts FROM messages WHERE channel_id = ? AND import_job = ? AND thread_ts IS NOT NULL AND thread_ts <> ts",
      params: [id, job.id],
    }),
    stmt(
      db,
      `UPDATE messages AS r SET parent_user_id = (SELECT h.user_id FROM messages h WHERE h.channel_id = r.channel_id AND h.ts = r.thread_ts)
       WHERE ${replies} AND parent_user_id IS NULL`,
      id,
      job.id,
    ),
    // So a later reply in an imported thread reaches the people in it (docs/activity.md).
    stmt(
      db,
      `INSERT OR IGNORE INTO thread_participants (channel_id, thread_ts, user_id)
       SELECT channel_id, thread_ts, user_id FROM messages
       WHERE channel_id = ?1 AND import_job = ?2 AND thread_ts IS NOT NULL AND user_id IS NOT NULL AND user_id <> '${SYSTEM_USER_ID}'`,
      id,
      job.id,
    ),
    // History arrives read.
    stmt(
      db,
      `UPDATE members SET last_read = max(last_read, ${newest})
       WHERE conversation_id = ?1 AND ${newest} IS NOT NULL`,
      id,
      job.id,
    ),
    stmt(
      db,
      `UPDATE conversations SET updated = max(updated, CAST(${newest} AS INTEGER))
       WHERE id = ?1 AND ${newest} IS NOT NULL`,
      id,
      job.id,
    ),
  ]
}
