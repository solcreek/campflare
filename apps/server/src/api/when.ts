// reminders.add's `time`: a Unix timestamp, seconds from now, or a small,
// well-defined set of phrases (docs/scheduling.md), read in the person's time zone.

const UNITS: Record<string, number> = {
  s: 1,
  sec: 1,
  secs: 1,
  second: 1,
  seconds: 1,
  m: 60,
  min: 60,
  mins: 60,
  minute: 60,
  minutes: 60,
  h: 3600,
  hr: 3600,
  hrs: 3600,
  hour: 3600,
  hours: 3600,
  d: 86_400,
  day: 86_400,
  days: 86_400,
  w: 604_800,
  week: 604_800,
  weeks: 604_800,
}

const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"]

/** A small number is seconds from now, as Slack reads one "within 24 hours"; a larger one is a Unix timestamp. */
const MAX_RELATIVE_SECONDS = 86_400

/** Hours and minutes when a day is named without a time. */
const DEFAULT_TIME = { hour: 9, minute: 0 }

export interface Wall {
  year: number
  month: number
  day: number
  hour: number
  minute: number
  second: number
  weekday: number
}

/** The zone if the runtime knows it (an IANA name, as ianaZone() takes them), else UTC. */
export const validZone = (tz: string | undefined): string => ianaZone(tz) ?? "UTC"

/**
 * `tz` if it is an IANA time zone the runtime knows, in the runtime's case
 * ("europe/paris" is Europe/Paris); undefined for anything else, a fixed
 * offset like "+02:00" included: a person's zone follows its DST rules. A
 * link keeps the name given (Asia/Kolkata, which the runtime calls
 * Asia/Calcutta), as Slack sends the current names.
 */
export function ianaZone(tz: string | undefined): string | undefined {
  const name = tz?.trim()
  if (!name || /^[+-]|^\d/.test(name)) return undefined
  try {
    const zone = new Intl.DateTimeFormat("en-US", { timeZone: name }).resolvedOptions().timeZone
    if (/^[+-]/.test(zone)) return undefined
    return zone.toLowerCase() === name.toLowerCase() ? zone : name
  } catch {
    return undefined
  }
}

/** How far the zone's wall clock is ahead of UTC at an instant (epoch seconds), in seconds: Slack's tz_offset. */
export function zoneOffset(tz: string, at = Math.floor(Date.now() / 1000)): number {
  return offsetMs(tz, at * 1000) / 1000
}

/** The zone's name for people at an instant, as Slack's tz_label: "Central European Summer Time". */
export function zoneLabel(tz: string, at = Math.floor(Date.now() / 1000)): string {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: tz, timeZoneName: "long" }).formatToParts(at * 1000)
  return parts.find((p) => p.type === "timeZoneName")?.value ?? tz
}

/** The wall-clock time in a zone at an instant (ms). */
export function wallIn(tz: string, ms: number): Wall {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    second: "numeric",
    weekday: "long",
    hourCycle: "h23",
  }).formatToParts(ms)
  const get = (type: string) => parts.find((p) => p.type === type)!.value
  return {
    year: Number(get("year")),
    month: Number(get("month")),
    day: Number(get("day")),
    hour: Number(get("hour")) % 24,
    minute: Number(get("minute")),
    second: Number(get("second")),
    weekday: WEEKDAYS.indexOf(get("weekday").toLowerCase()),
  }
}

/** How far the zone's wall clock is ahead of UTC at an instant, in ms. */
function offsetMs(tz: string, ms: number): number {
  const w = wallIn(tz, ms)
  return Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second) - Math.floor(ms / 1000) * 1000
}

/**
 * The instant (epoch seconds) a wall-clock time in a zone names. Days past the
 * month's end roll over (day + 1 is tomorrow). A time a DST change skips or
 * repeats lands on one of the instants next to it.
 */
export function zonedTime(tz: string, year: number, month: number, day: number, hour: number, minute: number) {
  const wall = Date.UTC(year, month - 1, day, hour, minute)
  const guess = wall - offsetMs(tz, wall)
  return (wall - offsetMs(tz, guess)) / 1000
}

/** Whether the date exists: February 31 doesn't, February 29 only in leap years. */
function realDate(year: number, month: number, day: number): boolean {
  const d = new Date(Date.UTC(year, month - 1, day))
  return d.getUTCFullYear() === year && d.getUTCMonth() === month - 1 && d.getUTCDate() === day
}

/** "9am", "5:30pm", "17:30", "noon", "midnight" as hours and minutes; undefined if it isn't one. */
function timeOfDay(text: string): { hour: number; minute: number } | undefined {
  if (text === "noon") return { hour: 12, minute: 0 }
  if (text === "midnight") return { hour: 0, minute: 0 }
  const match = /^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/.exec(text)
  if (!match) return undefined
  let hour = Number(match[1])
  const minute = Number(match[2] ?? "0")
  const meridiem = match[3]
  if (minute > 59) return undefined
  if (meridiem) {
    if (hour < 1 || hour > 12) return undefined
    hour = (hour % 12) + (meridiem === "pm" ? 12 : 0)
  } else if (hour > 23) {
    return undefined
  }
  return { hour, minute }
}

const DAY = "today|tomorrow|(?:on\\s+)?(?:" + WEEKDAYS.map((d) => `${d}|${d.slice(0, 3)}`).join("|") + ")"
const DAY_AND_TIME = new RegExp(`^(?:(${DAY})(?:\\s+(?:at\\s+)?(.+))?|at\\s+(.+)|(\\d.*(?:am|pm)|\\d{1,2}:\\d{2}))$`)

/**
 * When `input` says, as epoch seconds, or undefined when it says nothing this
 * understands. Times of day are in `tz`. A result may be in the past ("today
 * at 9am" in the afternoon): the caller decides what that means.
 */
export function parseWhen(input: string, tz: string, now = Math.floor(Date.now() / 1000)): number | undefined {
  const text = input.trim().toLowerCase().replace(/\.$/, "").replace(/\s+/g, " ")
  if (!text) return undefined
  if (/^\d+$/.test(text)) {
    const n = Number(text)
    return n <= MAX_RELATIVE_SECONDS ? now + n : n
  }

  const relative = /^(?:in )?(an?|\d+) ?([a-z]+)$/.exec(text)
  if (relative && UNITS[relative[2]!] && (text.startsWith("in ") || /^\d+[smhdw]$/.test(text))) {
    const count = relative[1] === "a" || relative[1] === "an" ? 1 : Number(relative[1])
    return now + count * UNITS[relative[2]!]!
  }

  // ISO 8601 with an offset names an instant by itself.
  if (/^\d{4}-\d{2}-\d{2}t\d{2}:\d{2}(:\d{2}(\.\d+)?)?(z|[+-]\d{2}:?\d{2})$/.test(text)) {
    const ms = Date.parse(text.toUpperCase())
    return Number.isNaN(ms) ? undefined : Math.floor(ms / 1000)
  }

  const zone = validZone(tz)
  const date = /^(\d{4})-(\d{2})-(\d{2})(?:(?:t| at | )(.+))?$/.exec(text)
  if (date) {
    const [year, month, day] = [Number(date[1]), Number(date[2]), Number(date[3])]
    const at = date[4] ? timeOfDay(date[4]) : DEFAULT_TIME
    if (!at || !realDate(year, month, day)) return undefined
    return zonedTime(zone, year, month, day, at.hour, at.minute)
  }

  const phrase = DAY_AND_TIME.exec(text)
  if (!phrase) return undefined
  const [, dayWord, dayTime, atTime, bareTime] = phrase
  const timeText = dayTime ?? atTime ?? bareTime
  const at = timeText === undefined ? undefined : timeOfDay(timeText)
  if (timeText !== undefined && !at) return undefined
  const today = wallIn(zone, now * 1000)
  const on = (offset: number, t = at ?? DEFAULT_TIME) =>
    zonedTime(zone, today.year, today.month, today.day + offset, t.hour, t.minute)

  if (!dayWord) {
    // A time alone is the next one: today, or tomorrow once it has passed.
    const when = on(0)
    return when > now ? when : on(1)
  }
  if (dayWord === "today") return at ? on(0) : undefined
  if (dayWord === "tomorrow") return on(1)
  const name = dayWord.replace(/^on\s+/, "")
  const weekday = WEEKDAYS.findIndex((d) => d === name || d.slice(0, 3) === name)
  // The next such day: a week on when it is today.
  return on((weekday - today.weekday + 7) % 7 || 7)
}
