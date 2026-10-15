import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test"
import { env } from "cloudflare:workers"
import { describe, expect, it } from "vitest"
import { issueToken } from "../src/api/auth"
import { nowSeconds } from "../src/api/ids"
import { runDue } from "../src/scheduler"
import { connect, expectError, ok, ORIGIN, settle, workspace } from "./helpers"

// Time zones (campflare.users.setTimezone) and statuses expiring (the Scheduler, docs/dnd.md).

type User = { id: string; tz: string; tz_label: string; tz_offset: number; profile: Record<string, unknown> }

const scheduler = (teamId: string) => env.SCHEDULER.get(env.SCHEDULER.idFromName(teamId))
const alarmOf = (teamId: string) => runInDurableObject(scheduler(teamId), (_s, state) => state.storage.getAlarm())
const info = (token: string, user: string) => ok<{ user: User }>("users.info", { user }, token).then((r) => r.user)

const rtm = async (token: string) => {
  const link = await connect((await ok<{ url: string }>("rtm.connect", {}, token)).url)
  await link.next((f) => f.type === "hello")
  return link
}

/** Pretends the status's time has come. */
const expireNow = (id: string) =>
  env.DB.prepare("UPDATE users SET status_expiration = ? WHERE id = ?")
    .bind(nowSeconds() - 1, id)
    .run()

describe("campflare.users.setTimezone", () => {
  it("sets the caller's zone, which users.info reports with Slack's label and offset", async () => {
    const w = await workspace()
    const bob = await w.addUser("bob")
    expect(await info(w.owner.token, bob.id)).toMatchObject({
      tz: "UTC",
      tz_label: "Coordinated Universal Time",
      tz_offset: 0,
    })
    const set = await ok<{ user: User }>("campflare.users.setTimezone", { tz: "asia/tokyo" }, bob.token)
    expect(set.user).toMatchObject({ id: bob.id, tz: "Asia/Tokyo", tz_label: "Japan Standard Time", tz_offset: 32_400 })
    expect(await info(w.owner.token, bob.id)).toMatchObject({ tz: "Asia/Tokyo", tz_offset: 32_400 })
    await ok("campflare.users.setTimezone", { tz: "America/Sao_Paulo" }, bob.token)
    expect(await info(bob.token, bob.id)).toMatchObject({ tz_label: "Brasilia Standard Time", tz_offset: -10_800 })
  })

  it("refuses what isn't an IANA zone", async () => {
    const w = await workspace()
    for (const tz of ["Mars/Olympus", "+02:00", "Europe/"]) {
      await expectError("campflare.users.setTimezone", { tz }, w.owner.token, "invalid_timezone")
    }
    await expectError("campflare.users.setTimezone", {}, w.owner.token, "invalid_arguments")
    expect(await info(w.owner.token, w.owner.id)).toMatchObject({ tz: "UTC" })
  })

  it("tells the workspace (user_change), and reminders read times in the new zone", async () => {
    const w = await workspace()
    const bob = await w.addUser("bob")
    const link = await rtm(w.owner.token)
    await ok("campflare.users.setTimezone", { tz: "Europe/Berlin" }, bob.token)
    const change = await link.next((f) => f.type === "user_change")
    expect(change.user).toMatchObject({ id: bob.id, tz: "Europe/Berlin" })
    link.close()
    // 9:00 in Tokyo is midnight UTC.
    await ok("campflare.users.setTimezone", { tz: "Asia/Tokyo" }, bob.token)
    const r = await ok<{ reminder: { time: number } }>("reminders.add", { text: "朝会", time: "tomorrow" }, bob.token)
    expect(r.reminder.time % 86_400).toBe(0)
  })

  it("wants users.profile:write", async () => {
    const w = await workspace()
    const reader = await issueToken(env, {
      teamId: w.teamId,
      kind: "user",
      userId: w.owner.id,
      scopes: ["read"],
      label: "lecteur",
    })
    await expectError("campflare.users.setTimezone", { tz: "Europe/Madrid" }, reader, "missing_scope")
  })
})

describe("status expiry", () => {
  it("arms the Scheduler, then clears the status when it expires and tells the workspace", async () => {
    const w = await workspace()
    const bob = await w.addUser("bob")
    const until = nowSeconds() + 3600
    await ok(
      "users.profile.set",
      { profile: { status_text: "En réunion", status_emoji: ":calendar:", status_expiration: until } },
      bob.token,
    )
    expect(await alarmOf(w.teamId)).toBe(until * 1000)

    const link = await rtm(w.owner.token)
    await expireNow(bob.id)
    expect(await runDurableObjectAlarm(scheduler(w.teamId))).toBe(true)
    const change = await link.next((f) => f.type === "user_change")
    expect((change.user as User).profile).toMatchObject({ status_text: "", status_emoji: "", status_expiration: 0 })
    // Its avatar URLs point at the server, as the request that armed it.
    expect((change.user as User).profile.image_72).toContain(ORIGIN)
    const row = await env.DB.prepare("SELECT status_text, status_expiration FROM users WHERE id = ?")
      .bind(bob.id)
      .first()
    expect(row).toEqual({ status_text: "", status_expiration: 0 })
    // Nothing left: no alarm.
    expect(await alarmOf(w.teamId)).toBeNull()
    link.close()
  })

  it("announces each expiry once, however many runs", async () => {
    const w = await workspace()
    const people = await Promise.all(["ana", "jurgen", "li"].map((n) => w.addUser(n)))
    for (const p of people) {
      await ok("users.profile.set", { profile: { status_text: "☕", status_expiration: nowSeconds() + 60 } }, p.token)
      await expireNow(p.id)
    }
    const link = await rtm(w.owner.token)
    const pending: Promise<unknown>[] = []
    await Promise.all([1, 2, 3].map(() => runDue(env, w.teamId, (p) => pending.push(p), nowSeconds(), ORIGIN)))
    await Promise.allSettled(pending)
    await settle(100)
    const changes = link.frames.filter((f) => f.type === "user_change").map((f) => (f.user as User).id)
    expect(changes.toSorted()).toEqual(people.map((p) => p.id).toSorted())
    link.close()
  })

  it("never clears a status set again before the alarm, and re-arms for the new one", async () => {
    const w = await workspace()
    const bob = await w.addUser("bob")
    await ok(
      "users.profile.set",
      { profile: { status_text: "Almuerzo", status_expiration: nowSeconds() + 60 } },
      bob.token,
    )
    await expireNow(bob.id)
    // A new status, with a later expiration, comes in just before the alarm rings.
    const later = nowSeconds() + 7200
    await ok("users.profile.set", { profile: { status_text: "通勤中", status_expiration: later } }, bob.token)
    await runDurableObjectAlarm(scheduler(w.teamId))
    expect((await info(bob.token, bob.id)).profile).toMatchObject({ status_text: "通勤中", status_expiration: later })
    expect(await alarmOf(w.teamId)).toBe(later * 1000)

    // One without an expiration isn't cleared either.
    await ok("users.profile.set", { profile: { status_text: "Vacances", status_expiration: 0 } }, bob.token)
    await runDue(env, w.teamId, () => {}, later + 1)
    expect((await info(bob.token, bob.id)).profile).toMatchObject({ status_text: "Vacances", status_expiration: 0 })
  })

  it("leaves deactivated people alone", async () => {
    const w = await workspace()
    const bob = await w.addUser("bob")
    await ok("users.profile.set", { profile: { status_text: "Bye", status_expiration: nowSeconds() + 60 } }, bob.token)
    await ok("campflare.users.deactivate", { user: bob.id }, w.owner.token)
    await expireNow(bob.id)
    await runDurableObjectAlarm(scheduler(w.teamId))
    expect(await alarmOf(w.teamId)).toBeNull()
  })
})
