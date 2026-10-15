import { method, type Actor, type Ctx } from "../api/context"
import { CampflareError } from "../api/errors"
import { nowSeconds, randomId } from "../api/ids"
import { parseWhen, validZone } from "../api/when"
import { all, first, stmt } from "../db/query"
import type { ReminderRow } from "../db/rows"
import { publish } from "../events"
import { armScheduler, reminderChanged, reminderJson } from "../scheduler"

// Slack's reminders.* (docs/scheduling.md): a reminder waits in D1 and the
// workspace's Scheduler DMs the person from the built-in bot at its time.
// Only for yourself, and never recurring (yet).

/** How far ahead a reminder may be, as on Slack. */
export const MAX_REMINDER_SECONDS = 5 * 365 * 86_400

method("reminders.add", "user", async (ctx) => {
  const text = ctx.args.req("text", "no_text")
  const user = ctx.args.str("user")
  if (user && user !== ctx.auth.user.id) throw new CampflareError("cannot_add_others")
  const timeArg = ctx.args.req("time", "cannot_parse")
  const now = nowSeconds()
  // Recurring reminders ("every Thursday") aren't supported yet.
  if (ctx.args.has("recurrence")) throw new CampflareError("invalid_recurrence")
  const time = parseWhen(timeArg, validZone(ctx.auth.user.tz), now)
  if (time === undefined) throw new CampflareError("cannot_parse")
  if (time <= now) throw new CampflareError("time_in_past")
  if (time > now + MAX_REMINDER_SECONDS) throw new CampflareError("time_too_far")

  const row: ReminderRow = {
    id: randomId("Rm"),
    team_id: ctx.auth.team.id,
    creator_id: ctx.auth.user.id,
    user_id: ctx.auth.user.id,
    text,
    time,
    complete_ts: 0,
    fired: 0,
    created: now,
    origin: ctx.origin,
    claimed_until: null,
    claim: null,
    attempts: 0,
  }
  await stmt(
    ctx.env.DB,
    "INSERT INTO reminders (id, team_id, creator_id, user_id, text, time, created, origin) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    row.id,
    row.team_id,
    row.creator_id,
    row.user_id,
    row.text,
    row.time,
    row.created,
    row.origin,
  ).run()
  await armScheduler(ctx.env, row.team_id, time)
  const reminder = reminderJson(row)
  publish(ctx, {
    teamId: row.team_id,
    audience: [row.user_id],
    rtmOnly: true,
    event: { type: "reminder_added", reminder },
  })
  return { reminder }
})

/** One of the caller's reminders. */
async function ownReminder(ctx: Ctx<Actor>): Promise<ReminderRow> {
  const row = await first<ReminderRow>(
    ctx.env.DB,
    "SELECT * FROM reminders WHERE id = ? AND user_id = ?",
    ctx.args.req("reminder", "not_found"),
    ctx.auth.user.id,
  )
  if (!row) throw new CampflareError("not_found")
  return row
}

method("reminders.info", "user", async (ctx) => ({ reminder: reminderJson(await ownReminder(ctx)) }))

method("reminders.list", "user", async (ctx) => {
  const rows = await all<ReminderRow>(
    ctx.env.DB,
    "SELECT * FROM reminders WHERE user_id = ? ORDER BY time, id",
    ctx.auth.user.id,
  )
  return { reminders: rows.map(reminderJson) }
})

/** Marks a reminder done (a second time changes nothing); one not yet fired won't. */
method("reminders.complete", "user", async (ctx) => {
  const id = ctx.args.req("reminder", "not_found")
  const db = ctx.env.DB
  const [completed, existing] = await db.batch([
    stmt(
      db,
      "UPDATE reminders SET complete_ts = ? WHERE id = ? AND user_id = ? AND complete_ts = 0 RETURNING *",
      nowSeconds(),
      id,
      ctx.auth.user.id,
    ),
    stmt(db, "SELECT id FROM reminders WHERE id = ? AND user_id = ?", id, ctx.auth.user.id),
  ])
  const row = completed!.results[0] as ReminderRow | undefined
  if (!row && !existing!.results.length) throw new CampflareError("not_found")
  if (row) reminderChanged(ctx.env, row, (p) => ctx.waitUntil(p))
  return {}
})

method("reminders.delete", "user", async (ctx) => {
  const row = await first<ReminderRow>(
    ctx.env.DB,
    "DELETE FROM reminders WHERE id = ? AND user_id = ? RETURNING *",
    ctx.args.req("reminder", "not_found"),
    ctx.auth.user.id,
  )
  if (!row) throw new CampflareError("not_found")
  publish(ctx, {
    teamId: row.team_id,
    audience: [row.user_id],
    rtmOnly: true,
    event: { type: "reminder_deleted", reminder_id: row.id },
  })
  return {}
})
