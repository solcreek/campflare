import { all, first } from "../db/query"
import type { UserRow } from "../db/rows"
import { method } from "../api/context"
import { parseDays, parseHour } from "../api/dnd-hours"
import { CampflareError, invalidArguments } from "../api/errors"
import { nowSeconds } from "../api/ids"
import { currentWindow, dndChanged, dndStatus, nextWindow, scheduleJson } from "../dnd"
import { armScheduler } from "../scheduler"

// Do Not Disturb (docs/dnd.md): scheduled hours in the person's time zone,
// and snoozing. Both silence the activity inbox's notify.

method("dnd.info", "actor", async (ctx) => {
  const id = ctx.args.str("user") ?? ctx.auth.user.id
  const user = await first<UserRow>(
    ctx.env.DB,
    "SELECT * FROM users WHERE id = ? AND team_id = ?",
    id,
    ctx.auth.team.id,
  )
  if (!user) throw new CampflareError("user_not_found")
  // The hours themselves are the person's own to see: others get only the next window, as on Slack.
  return { ...dndStatus(user), ...(user.id === ctx.auth.user.id ? { dnd_schedule: scheduleJson(user) } : {}) }
})

method("dnd.teamInfo", "actor", async (ctx) => {
  const ids = ctx.args.list("users")
  const rows = await all<UserRow>(ctx.env.DB, "SELECT * FROM users WHERE team_id = ? AND deleted = 0", ctx.auth.team.id)
  const now = nowSeconds()
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
  const { snooze_enabled, snooze_endtime, snooze_remaining, snooze_is_indefinite } = dndStatus(user)
  return { snooze_enabled, snooze_endtime, snooze_remaining, snooze_is_indefinite }
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
 * which is skipped (the next one comes as usual). Nothing to end changes nothing.
 */
method("dnd.endDnd", "user", async (ctx) => {
  const me = ctx.auth.user
  const now = nowSeconds()
  const w = currentWindow(me, now)
  const skip = w && w.start <= now ? nextWindow(me, w.end) : undefined
  if (!skip && me.snooze_until <= now) return {}
  // Guarded on the schedule it read, so a schedule set meanwhile isn't overwritten with this one's window.
  const user = await first<UserRow>(
    ctx.env.DB,
    `UPDATE users SET snooze_until = 0,
       dnd_window_start = CASE WHEN ?2 IS NULL THEN dnd_window_start ELSE ?2 END,
       dnd_window_end = CASE WHEN ?3 IS NULL THEN dnd_window_end ELSE ?3 END
     WHERE id = ?1 AND dnd_start = ?4 AND dnd_end = ?5 AND dnd_days = ?6 RETURNING *`,
    me.id,
    skip?.start ?? null,
    skip?.end ?? null,
    me.dnd_start,
    me.dnd_end,
    me.dnd_days,
  )
  if (!user) return {}
  if (skip) await armScheduler(ctx.env, ctx.auth.team.id, skip.end)
  dndChanged(ctx, ctx.auth.team.id, user)
  return {}
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
  const w = nextWindow({ tz: ctx.auth.user.tz, dnd_start: start, dnd_end: end, dnd_days: days }, now)
  const user = (await first<UserRow>(
    ctx.env.DB,
    `UPDATE users SET dnd_start = ?, dnd_end = ?, dnd_days = ?, dnd_window_start = ?, dnd_window_end = ?
     WHERE id = ? RETURNING *`,
    start,
    end,
    days,
    w?.start ?? 0,
    w?.end ?? 0,
    ctx.auth.user.id,
  ))!
  // The Scheduler moves the window on when it ends; answered only once that's armed.
  if (w) await armScheduler(ctx.env, ctx.auth.team.id, w.end)
  dndChanged(ctx, ctx.auth.team.id, user)
  return { ...dndStatus(user, now), dnd_schedule: scheduleJson(user) }
})
