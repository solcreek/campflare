import type { Actor, Ctx } from "../api/context"
import { CampflareError, invalidArguments } from "../api/errors"
import { stmt } from "../db/query"
import type { FileRow, MessageRow } from "../db/rows"
import { bump, limitExceeded, LIMITS, loadJob } from "./job"
import { SYSTEM_USER_ID, withoutFileLine } from "./text"

// campflare.import.files: attaches files the client uploaded
// (files.getUploadURLExternal, then the bytes) to an imported message, in
// place of their placeholder lines. Without it, files stay lines.

interface Item {
  source_id?: string
  file_id?: string
  title?: string
}

interface ImportFileRow {
  source_id: string
  channel_id: string
  ts: string
  name: string
  file_id: string | null
}

export async function importFiles(ctx: Ctx<Actor>) {
  const job = await loadJob(ctx, { running: true })
  const source = ctx.args.req("conversation", "channel_not_found")
  const ts = ctx.args.ts("ts")
  if (!ts) throw invalidArguments("missing required field: ts")
  const list = ctx.args.json<Item[]>("files")
  if (!Array.isArray(list) || list.length === 0) throw invalidArguments("files must be a non-empty JSON array")
  if (list.length > LIMITS.files) throw limitExceeded("files", LIMITS.files)
  for (const item of list) {
    if (!item?.source_id || !item.file_id) throw invalidArguments("each file needs a source_id and a file_id")
  }
  const db = ctx.env.DB
  const [message, records, uploads] = await db.batch([
    stmt(
      db,
      `SELECT m.* FROM import_conversations ic
       JOIN messages m ON m.channel_id = ic.conversation_id AND m.ts = ? AND m.import_job = ic.job_id
       WHERE ic.job_id = ? AND ic.source_id = ?`,
      ts,
      job.id,
      source,
    ),
    stmt(
      db,
      "SELECT * FROM import_files WHERE job_id = ? AND source_id IN (SELECT value FROM json_each(?))",
      job.id,
      JSON.stringify(list.map((i) => i.source_id)),
    ),
    stmt(
      db,
      "SELECT * FROM files WHERE team_id = ? AND id IN (SELECT value FROM json_each(?))",
      ctx.auth.team.id,
      JSON.stringify(list.map((i) => i.file_id)),
    ),
  ])
  const m = message!.results[0] as MessageRow | undefined
  if (!m) throw new CampflareError("message_not_found")
  const recordOf = new Map((records!.results as ImportFileRow[]).map((r) => [r.source_id, r]))
  const fileOf = new Map((uploads!.results as FileRow[]).map((f) => [f.id, f]))

  // The author owns them, as if they had uploaded them; a bot's or Slackbot's, the importing admin.
  const owner = m.user_id && m.user_id !== SYSTEM_USER_ID ? m.user_id : ctx.auth.user.id
  const attached: { source_id: string; file_id: string }[] = []
  const writes: D1PreparedStatement[] = []
  let text = m.text
  const ids = m.files ? (JSON.parse(m.files) as string[]) : []
  let skipped = 0
  for (const item of list) {
    const record = recordOf.get(item.source_id!)
    if (!record || record.channel_id !== m.channel_id || record.ts !== m.ts) throw new CampflareError("file_not_found")
    if (record.file_id) {
      skipped++
      continue
    }
    const f = fileOf.get(item.file_id!)
    if (!f || f.user_id !== ctx.auth.user.id) throw new CampflareError("file_not_found")
    if (f.status !== "uploaded") throw new CampflareError("file_upload_not_complete")
    text = withoutFileLine(text, record.name)
    ids.push(f.id)
    attached.push({ source_id: record.source_id, file_id: f.id })
    writes.push(
      stmt(
        db,
        "UPDATE files SET status = 'complete', user_id = ?, title = ?, channels = ?, import_job = ? WHERE id = ?",
        owner,
        item.title || record.name,
        JSON.stringify([m.channel_id]),
        job.id,
        f.id,
      ),
      stmt(
        db,
        "UPDATE import_files SET file_id = ? WHERE job_id = ? AND source_id = ?",
        f.id,
        job.id,
        record.source_id,
      ),
    )
  }
  if (attached.length) {
    await db.batch([
      ...writes,
      stmt(
        db,
        "UPDATE messages SET files = ?, text = ? WHERE channel_id = ? AND ts = ?",
        JSON.stringify(ids),
        text,
        m.channel_id,
        m.ts,
      ),
      bump(db, job.id, { files_attached: attached.length }),
    ])
  }
  return { attached: attached.length, skipped, files: attached }
}
