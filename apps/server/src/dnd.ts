import type { Ctx } from "./api/context"
import { inWindow, windowAt, type DndHours, type Window } from "./api/dnd-hours"
import { nowSeconds } from "./api/ids"
import { validZone } from "./api/when"
import type { UserRow } from "./db/rows"
import { publishEach } from "./events"
import type { PublishInput } from "./hub"

// A person's do-not-disturb state as Slack's dnd.* answer it (docs/dnd.md):
// the scheduled hours, from the window stored on the user row, and a snooze.

type DndUser = Pick<
  UserRow,
  | "id"
  | "tz"
  | "snooze_until"
  | "dnd_start"
  | "dnd_end"
  | "dnd_days"
  | "dnd_window_start"
  | "dnd_window_end"
  | "dnd_skipped_at"
>

/** Tries at a guarded write to a person's DND row that keeps changing under it, before giving up. */
export const ROW_TRIES = 3

/** The person's DND hours, or undefined when they have none. */
export function hoursOf(u: Pick<UserRow, "dnd_start" | "dnd_end" | "dnd_days">): DndHours | undefined {
  return u.dnd_start && u.dnd_end && u.dnd_days ? { start: u.dnd_start, end: u.dnd_end, days: u.dnd_days } : undefined
}

/**
 * The first window not over by `at`, in the person's zone: what the row should
 * store. The window that was in progress when they last ended DND
 * (`dnd_skipped_at`) is skipped, in whatever zone it is computed.
 */
export function nextWindow(
  u: Pick<UserRow, "tz" | "dnd_start" | "dnd_end" | "dnd_days" | "dnd_skipped_at">,
  at: number,
): Window | undefined {
  const hours = hoursOf(u)
  if (!hours) return undefined
  const tz = validZone(u.tz)
  const w = windowAt(hours, tz, at)
  return w && inWindow(w, u.dnd_skipped_at) ? windowAt(hours, tz, w.end) : w
}

/** Whether the stored window has ended without moving on: the Scheduler is late, or wasn't armed. */
export const staleWindow = (u: DndUser, now = nowSeconds()) => Boolean(hoursOf(u)) && u.dnd_window_end <= now

/**
 * The window in progress or next: the stored one while it lasts, else
 * computed, should the Scheduler be late moving it on.
 */
export function currentWindow(u: DndUser, now = nowSeconds()): Window | undefined {
  if (!hoursOf(u)) return undefined
  if (u.dnd_window_end > now) return { start: u.dnd_window_start, end: u.dnd_window_end }
  return nextWindow(u, now)
}

/** dnd_enabled and the next window, as Slack answers them (1 and 1 without a schedule). */
export function scheduleState(u: DndUser, now = nowSeconds()) {
  const w = currentWindow(u, now)
  return w
    ? { dnd_enabled: true, next_dnd_start_ts: w.start, next_dnd_end_ts: w.end }
    : { dnd_enabled: false, next_dnd_start_ts: 1, next_dnd_end_ts: 1 }
}

export function snoozeState(u: Pick<UserRow, "snooze_until">, now = nowSeconds()) {
  const snoozed = u.snooze_until > now
  return {
    snooze_enabled: snoozed,
    ...(snoozed
      ? { snooze_endtime: u.snooze_until, snooze_remaining: u.snooze_until - now, snooze_is_indefinite: false }
      : {}),
  }
}

/** dnd.info's answer: the schedule and the snooze. */
export const dndStatus = (u: DndUser, now = nowSeconds()) => ({ ...scheduleState(u, now), ...snoozeState(u, now) })

/** The schedule itself, for its owner: Campflare's addition to dnd.info. */
export function scheduleJson(u: Pick<UserRow, "dnd_start" | "dnd_end" | "dnd_days">) {
  const hours = hoursOf(u)
  return hours ? { start: hours.start, end: hours.end, days: hours.days.split(",") } : null
}

/**
 * Slack's two events for a change: dnd_updated to the person (snooze
 * included), dnd_updated_user to the workspace (the schedule only).
 */
export function dndEvents(teamId: string, u: DndUser, now = nowSeconds()): PublishInput[] {
  return [
    { teamId, audience: [u.id], event: { type: "dnd_updated", user: u.id, dnd_status: dndStatus(u, now) } },
    { teamId, audience: "team", event: { type: "dnd_updated_user", user: u.id, dnd_status: scheduleState(u, now) } },
  ]
}

export function dndChanged(ctx: Pick<Ctx, "env" | "waitUntil">, teamId: string, u: DndUser) {
  publishEach(ctx, teamId, dndEvents(teamId, u))
}
