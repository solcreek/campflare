import { method } from "../api/context"
import { CampflareError, invalidArguments } from "../api/errors"
import { nowSeconds, randomId } from "../api/ids"
import { requireAdmin } from "../api/roles"
import { all, first, stmt } from "../db/query"
import { importConversations } from "../import/conversations"
import { importFiles } from "../import/files"
import { finishImport } from "../import/finish"
import { jobJson, loadJob, type ImportJobRow, type JobOptions } from "../import/job"
import { importMessages } from "../import/messages"
import { undoImport } from "../import/undo"
import { importUsers } from "../import/users"

// campflare.import.*: importing another workspace's export, for admins
// (docs/import.md). The client reads the export and sends it in chunks.

const FORMATS = new Set(["slack-export"])

/**
 * Starts an import job, or answers the running one for the same export
 * (`fingerprint`), so a client re-run continues it.
 */
method("campflare.import.start", "user", async (ctx) => {
  requireAdmin(ctx)
  const format = ctx.args.str("format") ?? "slack-export"
  if (!FORMATS.has(format)) throw invalidArguments("format must be slack-export")
  const files = ctx.args.str("files") ?? "skip"
  if (files !== "skip" && files !== "download") throw invalidArguments("files must be skip or download")
  const fingerprint = ctx.args.str("fingerprint")
  if (fingerprint && fingerprint.length > 200) throw invalidArguments("fingerprint is at most 200 characters")
  const db = ctx.env.DB
  if (fingerprint) {
    const existing = await first<ImportJobRow>(
      db,
      `SELECT * FROM import_jobs WHERE team_id = ? AND fingerprint = ? AND state IN ('running', 'finished', 'undoing')
       ORDER BY created DESC LIMIT 1`,
      ctx.auth.team.id,
      fingerprint,
    )
    if (existing?.state === "running") return { job: jobJson(existing), resumed: true }
    if (existing) throw new CampflareError("already_imported", { job: jobJson(existing) })
  }
  const options: JobOptions = {
    merge_into_existing: ctx.args.bool("merge_into_existing"),
    files,
    ...(ctx.args.str("source_name") ? { source_name: ctx.args.str("source_name")!.slice(0, 200) } : {}),
  }
  const id = randomId("J")
  const now = nowSeconds()
  const job = await first<ImportJobRow>(
    db,
    `INSERT INTO import_jobs (id, team_id, created_by, format, fingerprint, options, created, updated)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`,
    id,
    ctx.auth.team.id,
    ctx.auth.user.id,
    format,
    fingerprint ?? null,
    JSON.stringify(options),
    now,
    now,
  )
  return { job: jobJson(job!), resumed: false }
})

method("campflare.import.users", "user", importUsers)
method("campflare.import.conversations", "user", importConversations)
method("campflare.import.messages", "user", importMessages)
method("campflare.import.files", "user", importFiles)
method("campflare.import.finish", "user", finishImport)
method("campflare.import.undo", "user", undoImport)

/** Files still to attach answered per call, with `files_after` for the next page. */
export const FILES_NEEDED_PER_PAGE = 500

/**
 * A job, with where each conversation's messages got to (`cursor`): what a
 * client resumes from. With `files_needed`, the export's files not attached
 * yet (a page, after `files_after`), whatever the message cursors say, so a
 * re-run retries the transfers that failed.
 */
method("campflare.import.status", "user", async (ctx) => {
  const job = await loadJob(ctx)
  const db = ctx.env.DB
  const files = ctx.args.bool("files_needed")
  const [conversations, needed] = await db.batch([
    stmt(
      db,
      "SELECT source_id, conversation_id, action, cursor, finished FROM import_conversations WHERE job_id = ? ORDER BY source_id",
      job.id,
    ),
    stmt(
      db,
      `SELECT source_id AS id, source_conversation AS conversation, ts, name FROM import_files
       WHERE job_id = ? AND file_id IS NULL AND source_id > ? AND ? ORDER BY source_id LIMIT ?`,
      job.id,
      ctx.args.str("files_after") ?? "",
      files ? 1 : 0,
      FILES_NEEDED_PER_PAGE + 1,
    ),
  ])
  const rows = conversations!.results as {
    source_id: string
    conversation_id: string
    action: string
    cursor: string | null
    finished: number
  }[]
  const page = (needed!.results as { id: string }[]).slice(0, FILES_NEEDED_PER_PAGE)
  return {
    job: jobJson(job),
    conversations: rows.map((c) => ({
      ...c,
      conversation_id: c.conversation_id || null,
      finished: Boolean(c.finished),
    })),
    ...(files
      ? {
          files_needed: page,
          files_after: needed!.results.length > FILES_NEEDED_PER_PAGE ? page.at(-1)!.id : null,
        }
      : {}),
  }
})

method("campflare.import.list", "user", async (ctx) => {
  requireAdmin(ctx)
  const jobs = await all<ImportJobRow>(
    ctx.env.DB,
    "SELECT * FROM import_jobs WHERE team_id = ? ORDER BY created DESC, id DESC LIMIT 100",
    ctx.auth.team.id,
  )
  return { jobs: jobs.map(jobJson) }
})
