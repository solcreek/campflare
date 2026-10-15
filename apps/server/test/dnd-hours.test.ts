import { describe, expect, it } from "vitest"
import { inWindow, parseDays, parseHour, windowAt, type DndHours } from "../src/api/dnd-hours"
import { ianaZone, zoneLabel, zoneOffset } from "../src/api/when"

const at = (iso: string) => Date.parse(iso) / 1000
const hours = (start: string, end: string, days = "sun,mon,tue,wed,thu,fri,sat"): DndHours => ({ start, end, days })

describe("time zones", () => {
  it("takes IANA names, in any case, and nothing else", () => {
    expect(ianaZone("Europe/Paris")).toBe("Europe/Paris")
    expect(ianaZone("asia/tokyo")).toBe("Asia/Tokyo")
    expect(ianaZone(" America/Sao_Paulo ")).toBe("America/Sao_Paulo")
    expect(ianaZone("UTC")).toBe("UTC")
    expect(ianaZone("etc/utc")).toBe("Etc/UTC")
    // A link the runtime knows by another name stays the one meant, in IANA's case whatever the case typed.
    expect(ianaZone("Asia/Kolkata")).toBe("Asia/Kolkata")
    expect(ianaZone("asia/kolkata")).toBe("Asia/Kolkata")
    expect(ianaZone("EUROPE/KYIV")).toBe("Europe/Kyiv")
    expect(ianaZone("us/eastern")).toBe("US/Eastern")
    expect(ianaZone("est5edt")).toBe("EST5EDT")
    expect(ianaZone("etc/gmt+5")).toBe("Etc/GMT+5")
    expect(ianaZone("america/buenos_aires")).toBe("America/Buenos_Aires")
    for (const bad of ["Mars/Olympus", "+02:00", "-0500", "", undefined, "Europe/", "9"]) {
      expect(ianaZone(bad)).toBeUndefined()
    }
  })

  it("gives Slack's tz_offset and tz_label for the instant, DST included", () => {
    const summer = at("2026-07-01T12:00:00Z")
    const winter = at("2026-01-15T12:00:00Z")
    expect(zoneOffset("Europe/Paris", summer)).toBe(7200)
    expect(zoneOffset("Europe/Paris", winter)).toBe(3600)
    expect(zoneLabel("Europe/Paris", summer)).toBe("Central European Summer Time")
    expect(zoneLabel("Europe/Paris", winter)).toBe("Central European Standard Time")
    expect(zoneOffset("America/New_York", summer)).toBe(-14_400)
    expect(zoneOffset("America/New_York", winter)).toBe(-18_000)
    expect(zoneOffset("Asia/Tokyo", summer)).toBe(32_400)
    expect(zoneLabel("Asia/Tokyo", winter)).toBe("Japan Standard Time")
    expect(zoneOffset("Asia/Kolkata", winter)).toBe(19_800)
    expect(zoneOffset("UTC", winter)).toBe(0)
    // Either side of Paris's change on 2026-10-25 at 01:00 UTC.
    expect(zoneOffset("Europe/Paris", at("2026-10-25T00:59:00Z"))).toBe(7200)
    expect(zoneOffset("Europe/Paris", at("2026-10-25T01:00:00Z"))).toBe(3600)
  })
})

describe("DND hours", () => {
  it("reads times of day and days", () => {
    expect(parseHour("22:00")).toBe("22:00")
    expect(parseHour("8:30")).toBe("08:30")
    for (const bad of ["24:00", "8", "10pm", "12:60", ""]) expect(parseHour(bad)).toBeUndefined()
    expect(parseDays("mon-fri")).toBe("mon,tue,wed,thu,fri")
    expect(parseDays("weekdays")).toBe("mon,tue,wed,thu,fri")
    expect(parseDays("Weekends")).toBe("sun,sat")
    expect(parseDays("every_day")).toBe("sun,mon,tue,wed,thu,fri,sat")
    expect(parseDays("fri-mon")).toBe("sun,mon,fri,sat")
    expect(parseDays("Monday, wed,friday")).toBe("mon,wed,fri")
    for (const bad of ["mo", "funday", "mon-", "mon-tue-wed", ""]) expect(parseDays(bad)).toBeUndefined()
  })

  it("finds the window in progress, else the next, across midnight", () => {
    const night = hours("22:00", "08:00")
    // Wednesday 2026-10-14.
    expect(windowAt(night, "UTC", at("2026-10-14T10:00:00Z"))).toEqual({
      start: at("2026-10-14T22:00:00Z"),
      end: at("2026-10-15T08:00:00Z"),
    })
    // Inside it, in the evening and the next morning.
    for (const t of ["2026-10-14T23:00:00Z", "2026-10-15T07:59:59Z"]) {
      expect(windowAt(night, "UTC", at(t))).toEqual({
        start: at("2026-10-14T22:00:00Z"),
        end: at("2026-10-15T08:00:00Z"),
      })
      expect(inWindow(windowAt(night, "UTC", at(t)), at(t))).toBe(true)
    }
    // Its end is the next one's turn.
    expect(windowAt(night, "UTC", at("2026-10-15T08:00:00Z"))?.start).toBe(at("2026-10-15T22:00:00Z"))
    expect(inWindow(windowAt(night, "UTC", at("2026-10-15T08:00:00Z")), at("2026-10-15T08:00:00Z"))).toBe(false)
  })

  it("reads the hours in the person's zone, on the days the windows start", () => {
    const weekNights = hours("22:00", "08:00", "mon,tue,wed,thu,fri")
    // Saturday noon in Tokyo: Friday's window is over, the next starts Monday night.
    expect(windowAt(weekNights, "Asia/Tokyo", at("2026-10-17T03:00:00Z"))).toEqual({
      start: at("2026-10-19T13:00:00Z"),
      end: at("2026-10-19T23:00:00Z"),
    })
    // Saturday 07:00 in Tokyo: Friday night's still runs.
    expect(windowAt(weekNights, "Asia/Tokyo", at("2026-10-16T22:00:00Z"))).toEqual({
      start: at("2026-10-16T13:00:00Z"),
      end: at("2026-10-16T23:00:00Z"),
    })
    // A window within a day.
    expect(windowAt(hours("12:30", "13:30", "sun"), "America/Sao_Paulo", at("2026-10-14T00:00:00Z"))).toEqual({
      start: at("2026-10-18T15:30:00Z"),
      end: at("2026-10-18T16:30:00Z"),
    })
    expect(windowAt(hours("22:00", "08:00", ""), "UTC", at("2026-10-14T00:00:00Z"))).toBeUndefined()
  })

  it("keeps the wall-clock hours across DST changes", () => {
    const night = hours("22:00", "08:00")
    // Paris falls back on the night of 24–25 October: 22:00 CEST to 08:00 CET is 11 hours.
    const autumn = windowAt(night, "Europe/Paris", at("2026-10-24T12:00:00Z"))!
    expect(autumn).toEqual({ start: at("2026-10-24T20:00:00Z"), end: at("2026-10-25T07:00:00Z") })
    // And springs forward on 28–29 March: 9 hours.
    const spring = windowAt(night, "Europe/Paris", at("2026-03-28T12:00:00Z"))!
    expect(spring).toEqual({ start: at("2026-03-28T21:00:00Z"), end: at("2026-03-29T06:00:00Z") })
    // New York springs forward on 8 March: 22:00 EST to 07:00 EDT.
    expect(windowAt(hours("22:00", "07:00"), "America/New_York", at("2026-03-07T12:00:00Z"))).toEqual({
      start: at("2026-03-08T03:00:00Z"),
      end: at("2026-03-08T11:00:00Z"),
    })
    // The window after the change starts at 22:00 local again.
    expect(windowAt(night, "Europe/Paris", autumn.end)?.start).toBe(at("2026-10-25T21:00:00Z"))
  })
})
