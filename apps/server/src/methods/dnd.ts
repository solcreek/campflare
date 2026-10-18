import { all, first } from "../db/query"
import type { UserRow } from "../db/rows"
import { method, type Actor, type Ctx } from "../api/context"
import { parseDays, parseHour } from "../api/dnd-hours"
import { CampflareError, invalidArguments } from "../api/errors"
import { nowSeconds } from "../api/ids"
import {
  currentWindow,
  dndChanged,
  dndStatus,
  nextWindow,
  ROW_TRIES,
  scheduleJson,
  snoozeState,
  staleWindow,
} from "../dnd"
import { armScheduler } from "../scheduler"

// Do Not Disturb (docs/dnd.md): scheduled hours in the person's time zone,
// and snoozing. Both silence the activity inbox's notify.

/**
 * A stored window that has ended without moving on means the Scheduler isn't
 * armed for it (or is late): arm it now, after the response, so it heals.
 * The answer is right meanwhile: dnd.info computes the window itself.
 */
function healStale(ctx: Ctx<Actor>, users: UserRow[], now: number) {
  if (users.some((u) => !u.deleted && staleWindow(u, now))) {
    ctx.waitUntil(
      armScheduler(ctx.env, ctx.auth.team.id, now).catch((error: unknown) => console.error("arm failed", error)),
    )
  }
}

method("dnd.info", "actor", async (ctx) => {
  const id = ctx.args.str("user") ?? ctx.auth.user.id
  const user = await first<UserRow>(
    ctx.env.DB,
    "SELECT * FROM users WHERE id = ? AND team_id = ?",
    id,
    ctx.auth.team.id,
  )
  if (!user) throw new CampflareError("user_not_found")
  const now = nowSeconds()
  healStale(ctx, [user], now)
  // The hours themselves are the person's own to see: others get only the next window, as on Slack.
  return { ...dndStatus(user, now), ...(user.id === ctx.auth.user.id ? { dnd_schedule: scheduleJson(user) } : {}) }
})

method("dnd.teamInfo", "actor", async (ctx) => {
  const ids = ctx.args.list("users")
  const rows = await all<UserRow>(ctx.env.DB, "SELECT * FROM users WHERE team_id = ? AND deleted = 0", ctx.auth.team.id)
  const now = nowSeconds()
  healStale(ctx, rows, now)
  const users = Object.fromEntries(
    rows.filter((u) => ids.length === 0 || ids.includes(u.id)).map((u) => [u.id, dndStatus(u, now)]),
  )
  return { users }
})

method("dnd.setSnooze", "user", async (ctx) => {
  const minutes = ctx.args.int("num_minutes", 0, { min: 0 })
  if (minutes <= 0) throw new CampflareError("invalid_num_minutes")
  const user = (await first<UserRow>(
    ctx.env.DB,
    "UPDATE users SET snooze_until = ? WHERE id = ? RETURNING *",
    nowSeconds() + minutes * 60,
    ctx.auth.user.id,
  ))!
  dndChanged(ctx, ctx.auth.team.id, user)
  return snoozeState(user)
})

method("dnd.endSnooze", "user", async (ctx) => {
  const user = await first<UserRow>(
    ctx.env.DB,
    "UPDATE users SET snooze_until = 0 WHERE id = ? AND snooze_until > ? RETURNING *",
    ctx.auth.user.id,
    nowSeconds(),
  )
  if (!user) throw new CampflareError("snooze_not_active")
  dndChanged(ctx, ctx.auth.team.id, user)
  return dndStatus(user)
})

/**
 * Ends do-not-disturb now: the snooze, and the scheduled window in progress,
 * which is skipped (the next one comes as usual), remembered as
 * `dnd_skipped_at` so a later change of zone skips it too. Nothing to end
 * changes nothing.
 */
method("dnd.endDnd", "user", async (ctx) => {
  let me: UserRow | undefined = ctx.auth.user
  for (let tries = 0; me && tries < ROW_TRIES; tries++) {
    const now = nowSeconds()
    const w = currentWindow(me, now)
    const inProgress = Boolean(w && w.start <= now)
    if (!inProgress && me.snooze_until <= now) return {}
    const next = inProgress ? nextWindow({ ...me, dnd_skipped_at: now }, now) : undefined
    // Guarded on the hours and zone it computed from: a change made meanwhile is read again and redone.
    const user: UserRow | undefined = await first<UserRow>(
      ctx.env.DB,
      `UPDATE users SET snooze_until = 0,
         dnd_skipped_at = CASE WHEN ?2 THEN ?3 ELSE dnd_skipped_at END,
         dnd_window_start = CASE WHEN ?2 THEN ?4 ELSE dnd_window_start END,
         dnd_window_end = CASE WHEN ?2 THEN ?5 ELSE dnd_window_end END
       WHERE id = ?1 AND dnd_start = ?6 AND dnd_end = ?7 AND dnd_days = ?8 AND tz = ?9 RETURNING *`,
      me.id,
      inProgress ? 1 : 0,
      now,
      next?.start ?? 0,
      next?.end ?? 0,
      me.dnd_start,
      me.dnd_end,
      me.dnd_days,
      me.tz,
    )
    if (user) {
      if (next) await armScheduler(ctx.env, ctx.auth.team.id, next.end)
      dndChanged(ctx, ctx.auth.team.id, user)
      return {}
    }
    me = await first<UserRow>(ctx.env.DB, "SELECT * FROM users WHERE id = ?", ctx.auth.user.id)
  }
  // Never answers ok without having ended it.
  throw new CampflareError("internal_error")
})

/**
 * Sets the caller's DND hours: `start` and `end` ("22:00", "08:00"; an end at
 * or before the start is the next morning), on `days` (default every day; the
 * days a window starts on), in their time zone. `enabled=false` clears them.
 */
method("campflare.dnd.setSchedule", "user", async (ctx) => {
  const enabled = ctx.args.bool("enabled", true)
  let start = ""
  let end = ""
  let days = ""
  if (enabled) {
    start = parseHour(ctx.args.req("start")) ?? ""
    end = parseHour(ctx.args.req("end")) ?? ""
    if (!start || !end) throw invalidArguments("start and end are times of day, HH:MM (22:00)")
    if (start === end) throw invalidArguments("start and end must differ")
    days = parseDays(ctx.args.str("days") ?? "every_day") ?? ""
    if (!days) throw invalidArguments("days are mon,tue… or a range (mon-fri), every_day, weekdays or weekends")
  }
  const now = nowSeconds()
  let tz: string | undefined = ctx.auth.user.tz
  let user: UserRow | undefined
  let w: ReturnType<typeof nextWindow>
  for (let tries = 0; tz !== undefined && !user && tries < ROW_TRIES; tries++) {
    // New hours start afresh: a window skipped under the old ones isn't skipped under these.
    w = nextWindow({ tz, dnd_start: start, dnd_end: end, dnd_days: days, dnd_skipped_at: 0 }, now)
    // Guarded on the zone it computed in: if it changed meanwhile, read it again.
    user = await first<UserRow>(
      ctx.env.DB,
      `UPDATE users SET dnd_start = ?1, dnd_end = ?2, dnd_days = ?3, dnd_window_start = ?4, dnd_window_end = ?5,
         dnd_skipped_at = 0
       WHERE id = ?6 AND tz = ?7 RETURNING *`,
      start,
      end,
      days,
      w?.start ?? 0,
      w?.end ?? 0,
      ctx.auth.user.id,
      tz,
    )
    if (!user) tz = (await first<UserRow>(ctx.env.DB, "SELECT * FROM users WHERE id = ?", ctx.auth.user.id))?.tz
  }
  if (!user) throw new CampflareError("internal_error")
  // The Scheduler moves the window on when it ends; answered only once that's armed.
  if (w) await armScheduler(ctx.env, ctx.auth.team.id, w.end)
  dndChanged(ctx, ctx.auth.team.id, user)
  return { ...dndStatus(user, now), dnd_schedule: scheduleJson(user) }
})
