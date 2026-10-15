import type { Actor, Ctx } from "../api/context"
import { normalizeEmail } from "../api/email-address"
import { invalidArguments } from "../api/errors"
import { ids, nowSeconds, randomId } from "../api/ids"
import { isNameClash, stmt } from "../db/query"
import { bump, limitExceeded, LIMITS, loadJob, type ImportJobRow } from "./job"
import { candidates, handleFrom, SYSTEM_USER_ID } from "./text"

// campflare.import.users: the export's people, mapped by email, or made
// deactivated placeholders (docs/import.md, Mapping).

export interface ExportUser {
  id: string
  name?: string
  real_name?: string
  deleted?: boolean
  is_bot?: boolean
  tz?: string
  profile?: { email?: string; real_name?: string; display_name?: string; title?: string }
}

type Action = "mapped" | "created" | "known"

interface Placeholder {
  id: string
  name: string
  real_name: string
  display_name: string
  title: string
  tz: string
  is_bot: number
}

const emailOf = (u: ExportUser) => (u.profile?.email ? normalizeEmail(u.profile.email) : undefined)

export async function importUsers(ctx: Ctx<Actor>) {
  const job = await loadJob(ctx, { running: true })
  const list = ctx.args.json<ExportUser[]>("users")
  if (!Array.isArray(list)) throw invalidArguments("users must be a JSON array")
  if (list.length > LIMITS.users) throw limitExceeded("users", LIMITS.users)
  const users = new Map<string, ExportUser>()
  for (const u of list) {
    if (!u || typeof u.id !== "string" || !u.id) throw invalidArguments("each user needs an id")
    users.set(u.id, u)
  }
  // A clash with someone added meanwhile: read again and pick other names, once.
  try {
    return await write(ctx, job, users)
  } catch (error) {
    if (!isNameClash(error)) throw error
    return write(ctx, job, users)
  }
}

async function write(ctx: Ctx<Actor>, job: ImportJobRow, users: Map<string, ExportUser>) {
  const db = ctx.env.DB
  const team = ctx.auth.team.id
  const sourceIds = [...users.keys()]
  const emails = [...users.values()].flatMap((u) => emailOf(u) ?? [])
  const names = [...users.values()].flatMap((u) => candidates(handleFrom(u.name || u.real_name || u.id)))
  const [known, byEmail, taken] = await db.batch([
    stmt(
      db,
      "SELECT source_id, user_id FROM import_users WHERE job_id = ? AND source_id IN (SELECT value FROM json_each(?))",
      job.id,
      JSON.stringify(sourceIds),
    ),
    stmt(
      db,
      "SELECT id, email FROM users WHERE team_id = ? AND email IN (SELECT value FROM json_each(?))",
      team,
      JSON.stringify(emails),
    ),
    stmt(
      db,
      `SELECT name FROM users WHERE team_id = ?1 AND name IN (SELECT value FROM json_each(?2))
       UNION SELECT handle FROM usergroups WHERE team_id = ?1 AND handle IN (SELECT value FROM json_each(?2))`,
      team,
      JSON.stringify(names),
    ),
  ])
  const mapping = new Map(
    (known!.results as { source_id: string; user_id: string }[]).map((r) => [r.source_id, r.user_id]),
  )
  const emailToUser = new Map((byEmail!.results as { id: string; email: string }[]).map((r) => [r.email, r.id]))
  const takenNames = new Set((taken!.results as { name: string }[]).map((r) => r.name))

  const out: { source_id: string; user_id: string; action: Action }[] = []
  const rows: [string, string, number][] = []
  const placeholders: Placeholder[] = []
  for (const u of users.values()) {
    const already = mapping.get(u.id)
    if (already) {
      out.push({ source_id: u.id, user_id: already, action: "known" })
      continue
    }
    const email = emailOf(u)
    const match = u.id === SYSTEM_USER_ID ? SYSTEM_USER_ID : email && emailToUser.get(email)
    if (match) {
      rows.push([u.id, match, 0])
      out.push({ source_id: u.id, user_id: match, action: "mapped" })
      continue
    }
    const base = handleFrom(u.name || u.real_name || u.id)
    const name = candidates(base).find((n) => !takenNames.has(n)) ?? `${base}-${randomId("", 4).toLowerCase()}`
    takenNames.add(name)
    const id = ids.user()
    placeholders.push({
      id,
      name,
      real_name: (u.real_name || u.profile?.real_name || "").slice(0, 200),
      display_name: (u.profile?.display_name || "").slice(0, 200),
      title: (u.profile?.title || "").slice(0, 200),
      tz: u.tz || "UTC",
      is_bot: u.is_bot ? 1 : 0,
    })
    rows.push([u.id, id, 1])
    out.push({ source_id: u.id, user_id: id, action: "created" })
  }

  const created = placeholders.length
  const mapped = rows.length - created
  if (rows.length) {
    const now = nowSeconds()
    await db.batch([
      // Deactivated, no email, no token: a name for the history, never an account (docs/import.md).
      ...(created
        ? [
            stmt(
              db,
              `INSERT INTO users (id, team_id, name, real_name, display_name, title, tz, is_bot, deleted, import_job, updated, created)
               SELECT value ->> 'id', ?, value ->> 'name', value ->> 'real_name', value ->> 'display_name',
                 value ->> 'title', value ->> 'tz', value ->> 'is_bot', 1, ?, ?, ?
               FROM json_each(?)`,
              team,
              job.id,
              now,
              now,
              JSON.stringify(placeholders),
            ),
          ]
        : []),
      stmt(
        db,
        `INSERT OR IGNORE INTO import_users (job_id, source_id, user_id, created)
         SELECT ?, value ->> 0, value ->> 1, value ->> 2 FROM json_each(?)`,
        job.id,
        JSON.stringify(rows),
      ),
      bump(db, job.id, { users_mapped: mapped, users_created: created }),
    ])
  }
  return { mapped, created, users: out }
}
