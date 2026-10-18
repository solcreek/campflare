import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test"
import { env } from "cloudflare:workers"
import { describe, expect, it } from "vitest"
import { issueToken } from "../src/api/auth"
import { windowAt } from "../src/api/dnd-hours"
import { nowSeconds } from "../src/api/ids"
import { runDue } from "../src/scheduler"
import { connect, eventually, expectError, ok, settle, workspace } from "./helpers"

// DND hours (campflare.dnd.setSchedule), as dnd.* report them and activity's notify honors them (docs/dnd.md).

interface Dnd {
  dnd_enabled: boolean
  next_dnd_start_ts: number
  next_dnd_end_ts: number
  snooze_enabled: boolean
  dnd_schedule?: { start: string; end: string; days: string[] } | null
}

const scheduler = (teamId: string) => env.SCHEDULER.get(env.SCHEDULER.idFromName(teamId))
const alarmOf = (teamId: string) => runInDurableObject(scheduler(teamId), (_s, state) => state.storage.getAlarm())
const dndInfo = (token: string, user?: string) => ok<Dnd>("dnd.info", user ? { user } : {}, token)
const setHours = (token: string, args: Record<string, unknown>) => ok<Dnd>("campflare.dnd.setSchedule", args, token)

/** "HH:00", `hours` from now in UTC. */
const hourFromNow = (hours: number) => `${String((new Date().getUTCHours() + hours + 24) % 24).padStart(2, "0")}:00`

const rtm = async (token: string) => {
  const link = await connect((await ok<{ url: string }>("rtm.connect", {}, token)).url)
  await link.next((f) => f.type === "hello")
  return link
}

const notifies = async (w: { owner: { token: string }; general: string }, who: { id: string; token: string }) => {
  await ok(
    "chat.postMessage",
    { channel: w.general, text: `<@${who.id}> ¿tienes un minuto? 少し時間ある?` },
    w.owner.token,
  )
  const { items } = await ok<{ items: { notify: boolean }[] }>("campflare.activity.list", { limit: 1 }, who.token)
  return items[0]!.notify
}

describe("campflare.dnd.setSchedule", () => {
  it("sets DND hours in the person's zone, which dnd.info reports as Slack's next window", async () => {
    const w = await workspace()
    const bob = await w.addUser("bob")
    expect(await dndInfo(bob.token)).toMatchObject({
      dnd_enabled: false,
      next_dnd_start_ts: 1,
      next_dnd_end_ts: 1,
      dnd_schedule: null,
    })
    await ok("campflare.users.setTimezone", { tz: "Europe/Paris" }, bob.token)
    const now = nowSeconds()
    const set = await setHours(bob.token, { start: "22:00", end: "8:00", days: "mon-fri" })
    const expected = windowAt({ start: "22:00", end: "08:00", days: "mon,tue,wed,thu,fri" }, "Europe/Paris", now)!
    expect(set).toMatchObject({
      dnd_enabled: true,
      next_dnd_start_ts: expected.start,
      next_dnd_end_ts: expected.end,
      snooze_enabled: false,
      dnd_schedule: { start: "22:00", end: "08:00", days: ["mon", "tue", "wed", "thu", "fri"] },
    })
    expect(await dndInfo(bob.token)).toMatchObject({ next_dnd_start_ts: expected.start })
    // Others see the window, not the hours.
    const seen = await dndInfo(w.owner.token, bob.id)
    expect(seen).toMatchObject({ dnd_enabled: true, next_dnd_end_ts: expected.end })
    expect(seen.dnd_schedule).toBeUndefined()
    const team = await ok<{ users: Record<string, Dnd> }>("dnd.teamInfo", {}, w.owner.token)
    expect(team.users[bob.id]).toMatchObject({ dnd_enabled: true, next_dnd_start_ts: expected.start })
    expect(team.users[w.owner.id]).toMatchObject({ dnd_enabled: false })
    // The Scheduler rings when the window ends, to move it on.
    expect(await alarmOf(w.teamId)).toBe(expected.end * 1000)

    // Moving to another zone keeps the hours at the same wall-clock times.
    await ok("campflare.users.setTimezone", { tz: "Asia/Seoul" }, bob.token)
    const seoul = windowAt({ start: "22:00", end: "08:00", days: "mon,tue,wed,thu,fri" }, "Asia/Seoul", nowSeconds())!
    expect(await dndInfo(bob.token)).toMatchObject({ next_dnd_start_ts: seoul.start, next_dnd_end_ts: seoul.end })

    expect(await setHours(bob.token, { enabled: false })).toMatchObject({
      dnd_enabled: false,
      next_dnd_start_ts: 1,
      dnd_schedule: null,
    })
  })

  it("refuses times, days and spans that aren't", async () => {
    const w = await workspace()
    for (const args of [
      { start: "25:00", end: "08:00" },
      { start: "22:00", end: "8pm" },
      { start: "22:00", end: "22:00" },
      { start: "22:00", end: "08:00", days: "someday" },
    ]) {
      await expectError("campflare.dnd.setSchedule", args, w.owner.token, "invalid_arguments")
    }
    await expectError("campflare.dnd.setSchedule", { end: "08:00" }, w.owner.token, "invalid_arguments")
  })

  it("wants dnd:write", async () => {
    const w = await workspace()
    const writer = await issueToken(env, {
      teamId: w.teamId,
      kind: "user",
      userId: w.owner.id,
      scopes: ["write"],
      label: "escritor",
    })
    await expectError("campflare.dnd.setSchedule", { start: "22:00", end: "07:00" }, writer, "missing_scope")
    await ok("dnd.info", {}, writer)
  })

  it("tells the person (dnd_updated) and the workspace (dnd_updated_user, without the snooze)", async () => {
    const w = await workspace()
    const bob = await w.addUser("bob")
    const mine = await rtm(bob.token)
    const theirs = await rtm(w.owner.token)
    await setHours(bob.token, { start: "21:30", end: "06:45" })
    const own = await mine.next((f) => f.type === "dnd_updated")
    expect(own).toMatchObject({ user: bob.id, dnd_status: { dnd_enabled: true, snooze_enabled: false } })
    const other = await theirs.next((f) => f.type === "dnd_updated_user")
    expect(other).toMatchObject({ user: bob.id, dnd_status: { dnd_enabled: true } })
    expect(other.dnd_status).not.toHaveProperty("snooze_enabled")
    await settle()
    expect(theirs.frames.some((f) => f.type === "dnd_updated")).toBe(false)

    await ok("dnd.setSnooze", { num_minutes: 10 }, bob.token)
    expect(await mine.next((f) => f.type === "dnd_updated")).toMatchObject({ dnd_status: { snooze_enabled: true } })
    mine.close()
    theirs.close()
  })
})

describe("notify", () => {
  it("is off within DND hours, and dnd.endDnd ends the window early", async () => {
    const w = await workspace()
    const bob = await w.addUser("bob")
    expect(await notifies(w, bob)).toBe(true)
    // Hours that started an hour ago, across midnight or not.
    const set = await setHours(bob.token, { start: hourFromNow(-1), end: hourFromNow(2) })
    expect(set.next_dnd_start_ts).toBeLessThanOrEqual(nowSeconds())
    expect(await notifies(w, bob)).toBe(false)

    const link = await rtm(w.owner.token)
    expect(await ok("dnd.endDnd", {}, bob.token)).toEqual({ ok: true })
    expect(await notifies(w, bob)).toBe(true)
    // The window skipped, the next is tomorrow's.
    const after = await dndInfo(bob.token)
    expect(after.next_dnd_start_ts).toBe(set.next_dnd_start_ts + 86_400)
    expect(await link.next((f) => f.type === "dnd_updated_user")).toMatchObject({
      dnd_status: { next_dnd_start_ts: after.next_dnd_start_ts },
    })
    link.close()
  })

  it("is on outside them", async () => {
    const w = await workspace()
    const bob = await w.addUser("bob")
    await setHours(bob.token, { start: hourFromNow(3), end: hourFromNow(5) })
    expect(await notifies(w, bob)).toBe(true)
  })

  it("dnd.endDnd ends a snooze too, and does nothing when nothing silences", async () => {
    const w = await workspace()
    const bob = await w.addUser("bob")
    expect(await ok("dnd.endDnd", {}, bob.token)).toEqual({ ok: true })
    await ok("dnd.setSnooze", { num_minutes: 30 }, bob.token)
    expect(await notifies(w, bob)).toBe(false)
    await ok("dnd.endDnd", {}, bob.token)
    expect(await dndInfo(bob.token)).toMatchObject({ snooze_enabled: false })
    expect(await notifies(w, bob)).toBe(true)
  })
})

describe("the Scheduler", () => {
  it("moves an ended window on to the next one, once, and tells the workspace", async () => {
    const w = await workspace()
    const bob = await w.addUser("bob")
    await ok("campflare.users.setTimezone", { tz: "America/New_York" }, bob.token)
    await setHours(bob.token, { start: "23:00", end: "07:00" })
    // Pretend the window ended a second ago.
    await env.DB.prepare("UPDATE users SET dnd_window_start = ?, dnd_window_end = ? WHERE id = ?")
      .bind(nowSeconds() - 3600, nowSeconds() - 1, bob.id)
      .run()
    const link = await rtm(w.owner.token)
    expect(await runDurableObjectAlarm(scheduler(w.teamId))).toBe(true)
    const pending: Promise<unknown>[] = []
    await Promise.all([1, 2].map(() => runDue(env, w.teamId, (p) => pending.push(p))))
    await Promise.allSettled(pending)

    const next = windowAt(
      { start: "23:00", end: "07:00", days: "sun,mon,tue,wed,thu,fri,sat" },
      "America/New_York",
      nowSeconds(),
    )!
    expect(await dndInfo(bob.token)).toMatchObject({ next_dnd_start_ts: next.start, next_dnd_end_ts: next.end })
    expect(await link.next((f) => f.type === "dnd_updated_user")).toMatchObject({
      user: bob.id,
      dnd_status: { next_dnd_start_ts: next.start },
    })
    await settle(100)
    expect(link.frames.filter((f) => f.type === "dnd_updated_user")).toEqual([])
    expect(await alarmOf(w.teamId)).toBe(next.end * 1000)
    link.close()
  })

  it("leaves a window a new schedule set", async () => {
    const w = await workspace()
    const bob = await w.addUser("bob")
    await setHours(bob.token, { start: "23:00", end: "07:00" })
    await env.DB.prepare("UPDATE users SET dnd_window_end = ? WHERE id = ?")
      .bind(nowSeconds() - 1, bob.id)
      .run()
    // The window is overdue when the person sets new hours; the run finds the new window, not due.
    const set = await setHours(bob.token, { start: "20:00", end: "06:00" })
    await runDue(env, w.teamId, () => {})
    expect(await dndInfo(bob.token)).toMatchObject({ next_dnd_end_ts: set.next_dnd_end_ts })
  })

  it("reports the next window even when the Scheduler is late, and arms it again", async () => {
    const w = await workspace()
    const bob = await w.addUser("bob")
    await setHours(bob.token, { start: "23:00", end: "07:00" })
    // The window went stale with no alarm set to move it on.
    await env.DB.prepare("UPDATE users SET dnd_window_start = 1, dnd_window_end = 2 WHERE id = ?").bind(bob.id).run()
    await runInDurableObject(scheduler(w.teamId), (_s, state) => state.storage.deleteAlarm())
    const next = windowAt({ start: "23:00", end: "07:00", days: "sun,mon,tue,wed,thu,fri,sat" }, "UTC", nowSeconds())!
    expect(await dndInfo(bob.token)).toMatchObject({ next_dnd_start_ts: next.start, next_dnd_end_ts: next.end })
    // Reading it armed the Scheduler (for now: it rings at once), whose run moves the window on and re-arms.
    await eventually(async () => {
      const row = await env.DB.prepare("SELECT dnd_window_end FROM users WHERE id = ?")
        .bind(bob.id)
        .first<{ dnd_window_end: number }>()
      return row?.dnd_window_end === next.end ? true : undefined
    })
    await eventually(async () => ((await alarmOf(w.teamId)) === next.end * 1000 ? true : undefined))
  })
})

describe("a skipped window", () => {
  it("stays skipped when the zone changes, and a change to the same zone changes nothing", async () => {
    const w = await workspace()
    const bob = await w.addUser("bob")
    // Hours around now in UTC, and in UTC+1 (Etc/GMT-1) too.
    await setHours(bob.token, { start: hourFromNow(-3), end: hourFromNow(3) })
    expect(await notifies(w, bob)).toBe(false)
    await ok("dnd.endDnd", {}, bob.token)
    const skipped = await dndInfo(bob.token)
    expect(skipped.next_dnd_start_ts).toBeGreaterThan(nowSeconds())

    const link = await rtm(w.owner.token)
    await ok("campflare.users.setTimezone", { tz: "UTC" }, bob.token)
    await settle()
    expect(link.frames.filter((f) => f.type === "user_change" || f.type === "dnd_updated_user")).toEqual([])
    expect(await dndInfo(bob.token)).toMatchObject({ next_dnd_start_ts: skipped.next_dnd_start_ts })

    await ok("campflare.users.setTimezone", { tz: "Etc/GMT-1" }, bob.token)
    const moved = await dndInfo(bob.token)
    // Tomorrow's window, an hour earlier in UTC: not the one in progress, which stays skipped.
    expect(moved.next_dnd_start_ts).toBe(skipped.next_dnd_start_ts - 3600)
    expect(await notifies(w, bob)).toBe(true)
    // Armed by the end of the new window at the latest (the skipped one's end may ring first, and re-arm).
    expect(await alarmOf(w.teamId)).toBeLessThanOrEqual(moved.next_dnd_end_ts * 1000)
    link.close()
  })

  it("is forgotten when new hours are set", async () => {
    const w = await workspace()
    const bob = await w.addUser("bob")
    await setHours(bob.token, { start: hourFromNow(-1), end: hourFromNow(2) })
    await ok("dnd.endDnd", {}, bob.token)
    expect(await notifies(w, bob)).toBe(true)
    await setHours(bob.token, { start: hourFromNow(-2), end: hourFromNow(2) })
    expect(await notifies(w, bob)).toBe(false)
  })
})
