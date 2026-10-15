import type { Actor, Ctx } from "../api/context"
import { CampflareError } from "../api/errors"
import { nowSeconds } from "../api/ids"
import { THUMB_VARIANTS, thumbKey } from "../api/thumbs"
import { all, first, stmt } from "../db/query"
import { recountThreads } from "./messages"
import { jobJson, loadJob, UNDO_WINDOW_SECONDS, type ImportJobRow } from "./job"

// campflare.import.undo: takes back everything a job wrote, a bounded piece
// per call (docs/import.md, Undo).

/** Messages deleted per call, with their reactions, stars and activity. */
export const UNDO_MESSAGES_PER_CALL = 2000
/** Files deleted per call: each is its R2 object and its thumbnails, and R2 deletes at most 1000 keys at once. */
export const UNDO_FILES_PER_CALL = 50

const KEYS = "(SELECT value ->> 0, value ->> 1 FROM json_each(?))"

/** The conversations the job created, as SQL. */
const CREATED = "(SELECT id FROM conversations WHERE import_job = ?)"
/** The users the job created (placeholders), as SQL. */
const PLACEHOLDERS = "(SELECT id FROM users WHERE import_job = ?)"

export async function undoImport(ctx: Ctx<Actor>) {
  const job = await loadJob(ctx)
  const db = ctx.env.DB
  const removed: Record<string, number> = {}
  if (job.state === "undone") return { done: true, removed, job: jobJson(job) }
  if (job.state === "finished" && nowSeconds() - (job.finished ?? 0) > UNDO_WINDOW_SECONDS) {
    throw new CampflareError("undo_window_passed")
  }
  if (job.state !== "undoing") {
    // People wrote in a conversation the import made, or replied to an imported message: removing
    // it would take their messages too, or leave their replies without a thread.
    const used = await all<{ id: string }>(
      db,
      `SELECT DISTINCT channel_id AS id FROM messages
       WHERE channel_id IN ${CREATED} AND import_job IS NOT ?
       UNION SELECT DISTINCT r.channel_id FROM messages h
       JOIN messages r ON r.channel_id = h.channel_id AND r.thread_ts = h.ts AND r.ts <> h.ts
       WHERE h.import_job = ? AND r.import_job IS NOT ? AND r.deleted = 0`,
      job.id,
      job.id,
      job.id,
      job.id,
    )
    if (used.length) throw new CampflareError("import_in_use", { conversations: used.map((u) => u.id) })
    await db
      .prepare("UPDATE import_jobs SET state = 'undoing', updated = ? WHERE id = ?")
      .bind(nowSeconds(), job.id)
      .run()
  }

  const keys = await all<{ channel_id: string; ts: string; thread_ts: string | null }>(
    db,
    "SELECT channel_id, ts, thread_ts FROM messages WHERE import_job = ? LIMIT ?",
    job.id,
    UNDO_MESSAGES_PER_CALL,
  )
  if (keys.length) {
    const list = JSON.stringify(keys.map((k) => [k.channel_id, k.ts]))
    const heads = JSON.stringify(
      keys.flatMap((k) => (k.thread_ts && k.thread_ts !== k.ts ? [[k.channel_id, k.thread_ts]] : [])),
    )
    const results = await db.batch([
      stmt(db, `DELETE FROM reactions WHERE (channel_id, ts) IN ${KEYS}`, list),
      stmt(db, `DELETE FROM stars WHERE (channel_id, ts) IN ${KEYS}`, list),
      stmt(db, `DELETE FROM activity WHERE (channel_id, ts) IN ${KEYS}`, list),
      stmt(db, `DELETE FROM thread_participants WHERE (channel_id, thread_ts) IN ${KEYS}`, list),
      stmt(db, `DELETE FROM messages WHERE (channel_id, ts) IN ${KEYS} AND import_job = ?`, list, job.id),
      // Heads that were here before and had imported replies: counted again, a head no more if none are left.
      recountThreads(
        db,
        { sql: `(h.channel_id, h.ts) IN ${KEYS} AND h.import_job IS NOT ?`, params: [heads, job.id] },
        { emptied: true },
      ),
    ])
    removed.reactions = results[0]!.meta.changes
    // meta.changes counts the search index's trigger writes too: every key found is one message.
    removed.messages = keys.length
    return { done: false, removed, job: jobJson(await reread(db, job)) }
  }

  const files = await all<{ id: string; team_id: string }>(
    db,
    "SELECT id, team_id FROM files WHERE import_job = ? LIMIT ?",
    job.id,
    UNDO_FILES_PER_CALL,
  )
  if (files.length) {
    await ctx.env.FILES.delete(
      files.flatMap((f) => [`${f.team_id}/${f.id}`, ...THUMB_VARIANTS.map((v) => thumbKey(f, v))]),
    )
    const ids = JSON.stringify(files.map((f) => f.id))
    await db.batch([
      stmt(db, "DELETE FROM stars WHERE file_id IN (SELECT value FROM json_each(?))", ids),
      stmt(db, "DELETE FROM files WHERE id IN (SELECT value FROM json_each(?))", ids),
    ])
    removed.files = files.length
    return { done: false, removed, job: jobJson(await reread(db, job)) }
  }

  const now = nowSeconds()
  const memberships = stmt(db, "DELETE FROM members WHERE import_job = ?", job.id)
  const conversations = stmt(db, "DELETE FROM conversations WHERE import_job = ?", job.id)
  const users = stmt(db, "DELETE FROM users WHERE import_job = ?", job.id)
  const statements = [
    stmt(db, "DELETE FROM reactions WHERE import_job = ?", job.id),
    memberships,
    // What hangs off the conversations it made: nothing of anyone else's (import_in_use above).
    ...["members WHERE conversation_id", "bookmarks WHERE channel_id", "stars WHERE channel_id"].map((t) =>
      stmt(db, `DELETE FROM ${t} IN ${CREATED}`, job.id),
    ),
    ...["activity", "thread_participants", "scheduled_messages", "reactions"].map((t) =>
      stmt(db, `DELETE FROM ${t} WHERE channel_id IN ${CREATED}`, job.id),
    ),
    stmt(db, `DELETE FROM notification_prefs WHERE conversation_id IN ${CREATED}`, job.id),
    conversations,
    stmt(db, `DELETE FROM usergroup_members WHERE user_id IN ${PLACEHOLDERS}`, job.id),
    stmt(db, `DELETE FROM members WHERE user_id IN ${PLACEHOLDERS}`, job.id),
    users,
    stmt(db, "DELETE FROM import_users WHERE job_id = ?", job.id),
    stmt(db, "DELETE FROM import_conversations WHERE job_id = ?", job.id),
    stmt(db, "DELETE FROM import_files WHERE job_id = ?", job.id),
    stmt(db, "DELETE FROM import_skipped WHERE job_id = ?", job.id),
    stmt(db, "UPDATE import_jobs SET state = 'undone', updated = ? WHERE id = ?", now, job.id),
  ]
  const results = await db.batch(statements)
  const changes = (s: D1PreparedStatement) => results[statements.indexOf(s)]!.meta.changes
  removed.memberships = changes(memberships)
  removed.conversations = changes(conversations)
  removed.users = changes(users)
  return { done: true, removed, job: jobJson(await reread(db, job)) }
}

const reread = async (db: D1Database, job: ImportJobRow) =>
  (await first<ImportJobRow>(db, "SELECT * FROM import_jobs WHERE id = ?", job.id))!
