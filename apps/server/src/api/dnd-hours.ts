import { wallIn, zonedTime } from "./when"

// Do-not-disturb hours (docs/dnd.md): a daily window in the person's time
// zone, "22:00" to "08:00", on some days of the week. A window belongs to the
// day it starts on, so 22:00–08:00 on Fridays runs from Friday night into
// Saturday morning. Windows are computed from wall-clock times through the
// zone's rules, so they follow DST: 22:00 stays 22:00 when the clocks change.

export const DAY_NAMES = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const

/** The schedule as stored (users.dnd_start, dnd_end, dnd_days): "22:00", "08:00", "mon,tue,wed,thu,fri". */
export interface DndHours {
  start: string
  end: string
  days: string
}

export interface Window {
  start: number
  end: number
}

/** "22:00", "8:00", "08:30" as "HH:MM"; undefined for anything else. */
export function parseHour(text: string): string | undefined {
  const match = /^(\d{1,2}):(\d{2})$/.exec(text.trim())
  if (!match) return undefined
  const [hour, minute] = [Number(match[1]), Number(match[2])]
  if (hour > 23 || minute > 59) return undefined
  return `${String(hour).padStart(2, "0")}:${match[2]}`
}

const FULL_NAMES = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"]

/** A day by its name or its first three letters or more: 0 for Sunday; -1 for none. */
const dayIndex = (name: string) => {
  const n = name.trim()
  return n.length < 3 ? -1 : FULL_NAMES.findIndex((f) => f.startsWith(n))
}

const ALIASES: Record<string, string> = {
  every_day: "sun-sat",
  everyday: "sun-sat",
  daily: "sun-sat",
  all: "sun-sat",
  weekdays: "mon-fri",
  weekends: "sat,sun",
}

/**
 * Days as stored, in week order from Sunday: "mon,tue,wed,thu,fri". Takes a
 * list ("mon,wed,fri"), a range ("mon-fri", "fri-mon" wraps), full names, or
 * every_day, weekdays, weekends; undefined if any part is none of those.
 */
export function parseDays(text: string): string | undefined {
  const spec = ALIASES[text.trim().toLowerCase()] ?? text.trim().toLowerCase()
  const days = new Set<number>()
  for (const part of spec.split(",")) {
    const [from, to, ...extra] = part.split("-")
    const a = dayIndex(from ?? "")
    const b = to === undefined ? a : dayIndex(to)
    if (a < 0 || b < 0 || extra.length) return undefined
    for (let d = a; ; d = (d + 1) % 7) {
      days.add(d)
      if (d === b) break
    }
  }
  return [...days]
    .toSorted((x, y) => x - y)
    .map((d) => DAY_NAMES[d])
    .join(",")
}

const minutes = (hour: string) => {
  const [h, m] = hour.split(":").map(Number)
  return { hour: h!, minute: m! }
}

/**
 * The first window of the schedule that hasn't ended at `at` (epoch seconds):
 * the one in progress, else the next. Undefined only for a schedule with no days.
 */
export function windowAt(hours: DndHours, tz: string, at: number): Window | undefined {
  const days = new Set(hours.days.split(",").filter(Boolean))
  if (days.size === 0) return undefined
  const start = minutes(hours.start)
  const end = minutes(hours.end)
  const overnight = end.hour * 60 + end.minute <= start.hour * 60 + start.minute
  const today = wallIn(tz, at * 1000)
  // From yesterday (a window that started last night may still run) through a week on.
  for (let k = -1; k <= 7; k++) {
    const date = new Date(Date.UTC(today.year, today.month - 1, today.day + k))
    if (!days.has(DAY_NAMES[date.getUTCDay()]!)) continue
    const [y, m, d] = [date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate()]
    const s = zonedTime(tz, y, m, d, start.hour, start.minute)
    const e = zonedTime(tz, y, m, d + (overnight ? 1 : 0), end.hour, end.minute)
    // A window a DST change squeezes to nothing (01:30–02:30 on a night that skips that hour) doesn't count.
    if (e > s && e > at) return { start: s, end: e }
  }
  return undefined
}

/** Whether `at` falls inside a window. */
export const inWindow = (w: Window | undefined, at: number) => Boolean(w && w.start <= at && at < w.end)
