import { describe, expect, it } from "vitest"
import { parseWhen, validZone, zonedTime } from "../src/api/when"

// Wednesday 2026-10-14 10:00:00 UTC.
const NOW = Date.UTC(2026, 9, 14, 10, 0, 0) / 1000
const at = (iso: string) => Date.parse(iso) / 1000
const when = (text: string, tz = "UTC") => parseWhen(text, tz, NOW)

describe("parseWhen", () => {
  it("reads numbers as Slack does: seconds from now within a day, else a Unix timestamp", () => {
    expect(when("900")).toBe(NOW + 900)
    expect(when("86400")).toBe(NOW + 86_400)
    expect(when("1800000000")).toBe(1_800_000_000)
  })

  it("reads relative times, spelled out or short", () => {
    expect(when("in 15 minutes")).toBe(NOW + 900)
    expect(when("In an hour.")).toBe(NOW + 3600)
    expect(when("in a day")).toBe(NOW + 86_400)
    expect(when("in 2 weeks")).toBe(NOW + 2 * 604_800)
    expect(when("in 30 secs")).toBe(NOW + 30)
    expect(when("30m")).toBe(NOW + 1800)
    expect(when("2h")).toBe(NOW + 7200)
    expect(when("1d")).toBe(NOW + 86_400)
    expect(when("1w")).toBe(NOW + 604_800)
    expect(when("in 3 fortnights")).toBeUndefined()
    expect(when("30 minutes")).toBeUndefined()
  })

  it("reads a time of day as the next one, in the person's zone", () => {
    expect(when("at 5pm")).toBe(at("2026-10-14T17:00:00Z"))
    expect(when("at 9am")).toBe(at("2026-10-15T09:00:00Z"))
    expect(when("at 17:30")).toBe(at("2026-10-14T17:30:00Z"))
    expect(when("5:30pm")).toBe(at("2026-10-14T17:30:00Z"))
    expect(when("at noon")).toBe(at("2026-10-14T12:00:00Z"))
    expect(when("at midnight")).toBe(at("2026-10-15T00:00:00Z"))
    // 10:00 UTC is 19:00 in Tokyo, 12:00 in Madrid (CEST), 06:00 in Montréal (EDT).
    expect(when("at 9am", "Asia/Tokyo")).toBe(at("2026-10-15T00:00:00Z"))
    expect(when("at 9am", "Europe/Madrid")).toBe(at("2026-10-15T07:00:00Z"))
    expect(when("at 9am", "America/Montreal")).toBe(at("2026-10-14T13:00:00Z"))
    expect(when("at 13pm")).toBeUndefined()
    expect(when("at 25:00")).toBeUndefined()
    expect(when("at 9:75")).toBeUndefined()
    expect(when("at teatime")).toBeUndefined()
  })

  it("reads today, tomorrow and weekdays, at 9:00 unless told", () => {
    expect(when("today at 5pm")).toBe(at("2026-10-14T17:00:00Z"))
    expect(when("today at 9am")).toBe(at("2026-10-14T09:00:00Z")) // past: the caller refuses it
    expect(when("today")).toBeUndefined()
    expect(when("tomorrow")).toBe(at("2026-10-15T09:00:00Z"))
    expect(when("tomorrow at 9:15am")).toBe(at("2026-10-15T09:15:00Z"))
    expect(when("tomorrow 18:00", "Asia/Seoul")).toBe(at("2026-10-15T09:00:00Z"))
    expect(when("friday")).toBe(at("2026-10-16T09:00:00Z"))
    expect(when("on Monday at 4pm")).toBe(at("2026-10-19T16:00:00Z"))
    expect(when("wed")).toBe(at("2026-10-21T09:00:00Z")) // today is Wednesday: a week on
    expect(when("tomorrow at nine")).toBeUndefined()
  })

  it("reads dates in the person's zone, and ISO 8601 with an offset as it says", () => {
    expect(when("2026-12-24 18:00", "Europe/Berlin")).toBe(at("2026-12-24T17:00:00Z"))
    expect(when("2026-12-24 at 6pm")).toBe(at("2026-12-24T18:00:00Z"))
    expect(when("2026-12-24", "Asia/Shanghai")).toBe(at("2026-12-24T01:00:00Z"))
    expect(when("2026-12-24T18:00:00Z")).toBe(at("2026-12-24T18:00:00Z"))
    expect(when("2026-12-24T18:00+02:00")).toBe(at("2026-12-24T16:00:00Z"))
    expect(when("2026-13-01")).toBeUndefined()
    expect(when("2026-00-10")).toBeUndefined()
    expect(when("2026-02-31")).toBeUndefined()
    expect(when("2026-04-31 09:00")).toBeUndefined()
    expect(when("2026-02-29")).toBeUndefined()
    expect(when("2028-02-29")).toBe(at("2028-02-29T09:00:00Z"))
    expect(when("2026-12-24 at dusk")).toBeUndefined()
  })

  it("understands nothing else", () => {
    for (const text of ["", "   ", "soon", "every thursday", "next week", "mañana", "明天", "내일"]) {
      expect(when(text)).toBeUndefined()
    }
  })
})

describe("time zones", () => {
  it("falls back to UTC for a zone the runtime doesn't know", () => {
    expect(validZone(undefined)).toBe("UTC")
    expect(validZone("Mars/Olympus_Mons")).toBe("UTC")
    expect(validZone("Asia/Tokyo")).toBe("Asia/Tokyo")
    expect(when("at 9am", "Mars/Olympus_Mons")).toBe(at("2026-10-15T09:00:00Z"))
  })

  it("maps wall-clock times across DST changes", () => {
    // Europe/Paris leaves summer time on 2026-10-25 at 03:00 local.
    expect(zonedTime("Europe/Paris", 2026, 10, 24, 9, 0)).toBe(at("2026-10-24T07:00:00Z"))
    expect(zonedTime("Europe/Paris", 2026, 10, 26, 9, 0)).toBe(at("2026-10-26T08:00:00Z"))
    // Days past the month's end roll over.
    expect(zonedTime("UTC", 2026, 10, 32, 9, 0)).toBe(at("2026-11-01T09:00:00Z"))
  })
})
