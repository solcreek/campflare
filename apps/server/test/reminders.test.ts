import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test"
import { env } from "cloudflare:workers"
import { describe, expect, it } from "vitest"
import { issueToken } from "../src/api/auth"
import { nowSeconds } from "../src/api/ids"
import { MAX_ATTEMPTS, runDue } from "../src/scheduler"
import { call, eventually, expectError, ok, workspace, type Workspace } from "./helpers"

type Reminder = {
  id: string
  creator: string
  user: string
  text: string
  recurring: boolean
  time: number
  complete_ts: number
}

const scheduler = (teamId: string) => env.SCHEDULER.get(env.SCHEDULER.idFromName(teamId))
const alarmOf = (teamId: string) => runInDurableObject(scheduler(teamId), (_s, state) => state.storage.getAlarm())

const add = (token: string, text: string, time: string | number) =>
  ok<{ reminder: Reminder }>("reminders.add", { text, time }, token).then((r) => r.reminder)

const makeDue = (id: string) =>
  env.DB.prepare("UPDATE reminders SET time = ? WHERE id = ?")
    .bind(nowSeconds() - 1, id)
    .run()

/** The person's DMs from the built-in bot, newest first. */
async function systemDms(w: Workspace, person: { token: string }) {
  const bot = await env.DB.prepare("SELECT bot_user_id FROM apps WHERE team_id = ? AND built_in = 'campflare'")
    .bind(w.teamId)
    .first<{ bot_user_id: string }>()
  if (!bot) return []
  const dm = await ok<{ channel: { id: string } }>("conversations.open", { users: bot.bot_user_id }, person.token)
  const res = await ok<{ messages: Record<string, unknown>[] }>(
    "conversations.history",
    { channel: dm.channel.id },
    person.token,
  )
  return res.messages
}

describe("reminders.add", () => {
  it("adds a reminder for yourself and answers Slack's shape", async () => {
    const w = await workspace()
    const before = nowSeconds()
    const reminder = await add(w.owner.token, "Llamar a Zoë", "in 15 minutes")
    expect(reminder).toEqual({
      id: expect.stringMatching(/^Rm[A-Z0-9]+$/),
      creator: w.owner.id,
      user: w.owner.id,
      text: "Llamar a Zoë",
      recurring: false,
      time: expect.any(Number),
      complete_ts: 0,
    })
    expect(reminder.time - before).toBeGreaterThanOrEqual(900)
    expect(reminder.time - before).toBeLessThanOrEqual(902)
    expect(await alarmOf(w.teamId)).toBe(reminder.time * 1000)
  })

  it("reads time in the person's zone", async () => {
    const w = await workspace()
    // No method sets a person's zone yet; the column is what reminders read.
    await env.DB.prepare("UPDATE users SET tz = 'Asia/Tokyo' WHERE id = ?").bind(w.owner.id).run()
    const reminder = await add(w.owner.token, "会議", "tomorrow at 9am")
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: "Asia/Tokyo",
      hour: "numeric",
      minute: "numeric",
      hourCycle: "h23",
    }).format(reminder.time * 1000)
    expect(parts).toBe("09:00")
    // A Unix timestamp is taken as it is.
    const at = nowSeconds() + 90_000
    expect((await add(w.owner.token, "회의", String(at))).time).toBe(at)
  })

  it("refuses what it can't do", async () => {
    const w = await workspace()
    const bob = await w.addUser("bob")
    const err = (args: Record<string, unknown>, code: string) => expectError("reminders.add", args, w.owner.token, code)
    await err({ time: "in 1 hour" }, "no_text")
    await err({ text: "x" }, "cannot_parse")
    await err({ text: "x", time: "whenever" }, "cannot_parse")
    await err({ text: "x", time: "every thursday" }, "cannot_parse")
    await err({ text: "x", time: "in 1 hour", recurrence: { frequency: "daily" } }, "invalid_recurrence")
    await err({ text: "x", time: "0" }, "time_in_past")
    await err({ text: "x", time: String(nowSeconds() + 6 * 365 * 86_400) }, "time_too_far")
    await err({ text: "x", time: "in 1 hour", user: bob.id }, "cannot_add_others")
    await ok("reminders.add", { text: "x", time: "in 1 hour", user: w.owner.id }, w.owner.token)
    const app = await w.addApp("Bot")
    await expectError("reminders.add", { text: "x", time: "in 1 hour" }, app.botToken, "not_allowed_token_type")
  })
})

describe("reminders.info, list, complete and delete", () => {
  it("shows, completes and deletes your own reminders, and only yours", async () => {
    const w = await workspace()
    const bob = await w.addUser("bob")
    const later = await add(w.owner.token, "later", "in 2 hours")
    const soon = await add(w.owner.token, "soon", "in 1 hour")
    const bobs = await add(bob.token, "Bob's", "in 1 hour")

    expect((await ok<{ reminder: Reminder }>("reminders.info", { reminder: soon.id }, w.owner.token)).reminder).toEqual(
      soon,
    )
    await expectError("reminders.info", { reminder: bobs.id }, w.owner.token, "not_found")
    await expectError("reminders.info", {}, w.owner.token, "not_found")
    const list = await ok<{ reminders: Reminder[] }>("reminders.list", {}, w.owner.token)
    expect(list.reminders.map((r) => r.text)).toEqual(["soon", "later"])

    await ok("reminders.complete", { reminder: soon.id }, w.owner.token)
    const done = (await ok<{ reminder: Reminder }>("reminders.info", { reminder: soon.id }, w.owner.token)).reminder
    expect(done.complete_ts).toBeGreaterThan(0)
    // Again changes nothing.
    await ok("reminders.complete", { reminder: soon.id }, w.owner.token)
    expect((await ok<{ reminder: Reminder }>("reminders.info", { reminder: soon.id }, w.owner.token)).reminder).toEqual(
      done,
    )
    await expectError("reminders.complete", { reminder: bobs.id }, w.owner.token, "not_found")

    await expectError("reminders.delete", { reminder: bobs.id }, w.owner.token, "not_found")
    await ok("reminders.delete", { reminder: later.id }, w.owner.token)
    await expectError("reminders.delete", { reminder: later.id }, w.owner.token, "not_found")
    expect(
      (await ok<{ reminders: Reminder[] }>("reminders.list", {}, w.owner.token)).reminders.map((r) => r.id),
    ).toEqual([soon.id])
  })

  it("tells the person's clients", async () => {
    const w = await workspace()
    const { cursor } = await ok<{ cursor: string }>("campflare.events.poll", {}, w.owner.token)
    const r = await add(w.owner.token, "Café à 16 h", "in 1 hour")
    await ok("reminders.complete", { reminder: r.id }, w.owner.token)
    await ok("reminders.delete", { reminder: r.id }, w.owner.token)
    const events = await eventually(async () => {
      const page = await ok<{ events: { event: Record<string, unknown> }[] }>(
        "campflare.events.poll",
        { cursor, wait: 1 },
        w.owner.token,
      )
      return page.events.length >= 3 ? page.events.map((e) => e.event) : undefined
    })
    expect(events).toEqual(
      [
        { type: "reminder_added", reminder: r },
        { type: "reminder_changed", reminder: { ...r, complete_ts: expect.any(Number) } },
        { type: "reminder_deleted", reminder_id: r.id },
      ].map((e) => expect.objectContaining(e)),
    )
  })

  it("wants reminders:read to look and reminders:write to change", async () => {
    const w = await workspace()
    const r = await add(w.owner.token, "x", "in 1 hour")
    const reader = await issueToken(env, {
      teamId: w.teamId,
      kind: "user",
      userId: w.owner.id,
      scopes: ["read"],
      label: "r",
    })
    await ok("reminders.list", {}, reader)
    await ok("reminders.info", { reminder: r.id }, reader)
    await expectError("reminders.add", { text: "x", time: "in 1 hour" }, reader, "missing_scope")
    await expectError("reminders.complete", { reminder: r.id }, reader, "missing_scope")
    await expectError("reminders.delete", { reminder: r.id }, reader, "missing_scope")
    const writer = await issueToken(env, {
      teamId: w.teamId,
      kind: "user",
      userId: w.owner.id,
      scopes: ["write"],
      label: "w",
    })
    await ok("reminders.complete", { reminder: r.id }, writer)
  })
})

describe("firing", () => {
  it("DMs the person from the built-in bot, once, and keeps the reminder until completed", async () => {
    const w = await workspace()
    const bob = await w.addUser("bob")
    const r = await add(bob.token, "Tee trinken", "in 1 hour")
    const next = await add(bob.token, "next", "in 2 hours")
    await makeDue(r.id)
    expect(await runDurableObjectAlarm(scheduler(w.teamId))).toBe(true)
    const pending: Promise<unknown>[] = []
    // Another run, or several at once, change nothing.
    await Promise.all([1, 2].map(() => runDue(env, w.teamId, (p) => pending.push(p))))
    await Promise.allSettled(pending)

    const dms = await systemDms(w, bob)
    expect(dms.map((m) => m.text)).toEqual(["Reminder: Tee trinken"])
    expect(dms[0]).toMatchObject({ bot_id: expect.any(String) })
    const info = await ok<{ user: { real_name: string; is_bot: boolean } }>(
      "users.info",
      { user: dms[0]!.user },
      bob.token,
    )
    expect(info.user).toMatchObject({ real_name: "Campflare", is_bot: true })

    // Still listed, not complete, until the person says so.
    expect(
      (await ok<{ reminder: Reminder }>("reminders.info", { reminder: r.id }, bob.token)).reminder.complete_ts,
    ).toBe(0)
    expect(await alarmOf(w.teamId)).toBe(next.time * 1000)
    await ok("reminders.complete", { reminder: r.id }, bob.token)
  })

  it("never fires one completed or deleted before its time", async () => {
    const w = await workspace()
    const done = await add(w.owner.token, "done early", "in 1 hour")
    const gone = await add(w.owner.token, "deleted", "in 1 hour")
    await ok("reminders.complete", { reminder: done.id }, w.owner.token)
    await ok("reminders.delete", { reminder: gone.id }, w.owner.token)
    await makeDue(done.id)
    await runDurableObjectAlarm(scheduler(w.teamId))
    expect(await systemDms(w, w.owner)).toEqual([])
  })

  it("drops one for a deactivated person without a DM", async () => {
    const w = await workspace()
    const bob = await w.addUser("bob")
    const r = await add(bob.token, "x", "in 1 hour")
    await ok("campflare.users.deactivate", { user: bob.id }, w.owner.token)
    await makeDue(r.id)
    await runDurableObjectAlarm(scheduler(w.teamId))
    const row = await env.DB.prepare("SELECT fired FROM reminders WHERE id = ?").bind(r.id).first<{ fired: number }>()
    expect(row?.fired).toBe(1)
    expect(
      await env.DB.prepare("SELECT COUNT(*) AS n FROM apps WHERE team_id = ? AND built_in IS NOT NULL")
        .bind(w.teamId)
        .first("n"),
    ).toBe(0)
  })

  it("retries after an unexpected error, then gives up", async () => {
    const w = await workspace()
    const r = await add(w.owner.token, "unlucky", "in 1 hour")
    await env.DB.prepare("UPDATE reminders SET time = ?, origin = 'not a url' WHERE id = ?")
      .bind(nowSeconds() - 1, r.id)
      .run()
    const pending: Promise<unknown>[] = []
    const now = nowSeconds()
    expect(await runDue(env, w.teamId, (p) => pending.push(p), now)).toBeGreaterThan(now)
    const row = () => env.DB.prepare("SELECT fired, attempts FROM reminders WHERE id = ?").bind(r.id).first()
    expect(await row()).toEqual({ fired: 0, attempts: 1 })
    await env.DB.prepare("UPDATE reminders SET attempts = ?, claimed_until = NULL WHERE id = ?")
      .bind(MAX_ATTEMPTS - 1, r.id)
      .run()
    expect(await runDue(env, w.teamId, (p) => pending.push(p), now)).toBeUndefined()
    expect(await row()).toEqual({ fired: 1, attempts: MAX_ATTEMPTS })
    await Promise.allSettled(pending)
    expect(await call("reminders.info", { reminder: r.id }, w.owner.token)).toMatchObject({ ok: true })
  })
})
