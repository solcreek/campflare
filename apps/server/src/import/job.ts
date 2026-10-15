import type { Actor, Ctx } from "../api/context"
import { CampflareError } from "../api/errors"
import { nowSeconds } from "../api/ids"
import { requireAdmin } from "../api/roles"
import { first, stmt } from "../db/query"

// Import jobs (docs/import.md): what an import is doing, and what it wrote.

export type JobState = "running" | "finished" | "undoing" | "undone"

export interface ImportJobRow {
  id: string
  team_id: string
  created_by: string
  format: string
  fingerprint: string | null
  state: JobState
  options: string
  counts: string
  created: number
  updated: number
  finished: number | null
}

export interface JobOptions {
  merge_into_existing: boolean
  files: "skip" | "download"
  source_name?: string
}

export type Counts = Record<string, number | string[]>

/** Most of one call: past these, `limit_exceeded`. */
export const LIMITS = {
  users: 500,
  conversations: 200,
  messages: 1000,
  /** The messages argument, as JSON, in bytes. */
  messageBytes: 4 * 1024 * 1024,
  files: 10,
}

/** How long after finishing an import can be undone. */
export const UNDO_WINDOW_SECONDS = 7 * 86_400

/** Unmapped user ids kept on a job, at most. */
export const MAX_UNMAPPED = 100

export const limitExceeded = (what: string, max: number) =>
  new CampflareError("limit_exceeded", { max, response_metadata: { messages: [`[ERROR] at most ${max} ${what}`] } })

/** A job of the caller's workspace, for an admin; with `running`, one that still takes writes. */
export async function loadJob(ctx: Ctx<Actor>, { running = false } = {}): Promise<ImportJobRow> {
  requireAdmin(ctx)
  const id = ctx.args.req("job", "import_not_found")
  const job = await first<ImportJobRow>(
    ctx.env.DB,
    "SELECT * FROM import_jobs WHERE id = ? AND team_id = ?",
    id,
    ctx.auth.team.id,
  )
  if (!job) throw new CampflareError("import_not_found")
  if (running) requireRunning(job)
  return job
}

export function requireRunning(job: ImportJobRow) {
  if (job.state !== "running") throw new CampflareError("import_not_running", { state: job.state })
}

/** A job as the API answers it. Files not attached are the files skipped. */
export function jobJson(job: ImportJobRow) {
  const counts = JSON.parse(job.counts) as Counts
  const files = Number(counts.files ?? 0)
  const attached = Number(counts.files_attached ?? 0)
  return {
    id: job.id,
    state: job.state,
    format: job.format,
    options: JSON.parse(job.options) as JobOptions,
    counts: {
      users_mapped: 0,
      users_created: 0,
      conversations_created: 0,
      conversations_renamed: 0,
      conversations_merged: 0,
      conversations_skipped: 0,
      messages: 0,
      messages_skipped: 0,
      reactions: 0,
      pins: 0,
      unmapped_users: [],
      ...counts,
      files,
      files_attached: attached,
      files_skipped: files - attached,
    },
    created_by: job.created_by,
    created: job.created,
    updated: job.updated,
    finished: job.finished,
  }
}

/**
 * Adds to a job's counts. A count given as SQL (`changes()`) is evaluated in
 * the statement: placed right after an `INSERT OR IGNORE` in a batch, it counts
 * the rows that INSERT wrote, so a re-sent chunk adds nothing. Skipped rows are
 * counted the same way, from the import tables that note them (import_skipped,
 * import_conversations); a number counts what the call is the first to map.
 */
export function bump(db: D1Database, jobId: string, add: Record<string, number | { sql: string; params: unknown[] }>) {
  let expr = "counts"
  const params: unknown[] = []
  for (const [key, value] of Object.entries(add)) {
    const by = typeof value === "number" ? { sql: "?", params: [value] } : value
    expr = `json_set(${expr}, '$.${key}', coalesce(json_extract(counts, '$.${key}'), 0) + (${by.sql}))`
    params.push(...by.params)
  }
  return stmt(db, `UPDATE import_jobs SET counts = ${expr}, updated = ? WHERE id = ?`, ...params, nowSeconds(), jobId)
}

/** The rows the statement before this one wrote. */
export const CHANGES = { sql: "changes()", params: [] }
