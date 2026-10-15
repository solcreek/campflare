import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test"
import { env } from "cloudflare:workers"
import { describe, expect, it } from "vitest"
import { issueToken } from "../src/api/auth"
import { nowSeconds } from "../src/api/ids"
import type { ScheduledMessageRow } from "../src/db/rows"
import { CLAIM_SECONDS, MAX_ATTEMPTS, runDue } from "../src/scheduler"
import { call, connect, eventually, expectError, ok, workspace, type Workspace } from "./helpers"

type Scheduled = { scheduled_message_id: string; post_at: number; channel: string; message: Record<string, unknown> }
type Listed = {
  scheduled_messages: { id: string; channel_id: string; post_at: number; date_created: number; text: string }[]
  response_metadata: { next_cursor: string }
}
type History = { messages: Record<string, unknown>[] }

const scheduler = (teamId: string) => env.SCHEDULER.get(env.SCHEDULER.idFromName(teamId))
const alarmOf = (teamId: string) => runInDurableObject(scheduler(teamId), (_s, state) => state.storage.getAlarm())

/** Makes a scheduled message due now, as if its time had come. */
const makeDue = (id: string) =>
  env.DB.prepare("UPDATE scheduled_messages SET post_at = ? WHERE id = ?")
    .bind(nowSeconds() - 1, id)
    .run()

const rowOf = (id: string) =>
  env.DB.prepare("SELECT * FROM scheduled_messages WHERE id = ?").bind(id).first<ScheduledMessageRow>()

const schedule = (w: Workspace, args: Record<string, unknown>, token = w.owner.token) =>
  ok<Scheduled>("chat.scheduleMessage", { channel: w.general, post_at: nowSeconds() + 600, ...args }, token)

const history = async (channel: string, token: string) =>
  (await ok<History>("conversations.history", { channel }, token)).messages

/** A public channel the owner made and `member` joined (#general can't be left). */
async function room(w: Workspace, member: { token: string }, name = "sala") {
  const { channel } = await ok<{ channel: { id: string } }>("conversations.create", { name }, w.owner.token)
  await ok("conversations.join", { channel: channel.id }, member.token)
  return channel.id
}

/** The workspace's DMs from the built-in bot to a person, newest first. */
async function systemDms(w: Workspace, person: { id: string; token: string }) {
  const bot = await env.DB.prepare("SELECT bot_user_id FROM apps WHERE team_id = ? AND built_in = 'campflare'")
    .bind(w.teamId)
    .first<{ bot_user_id: string }>()
  if (!bot) return []
  const dm = await ok<{ channel: { id: string } }>("conversations.open", { users: bot.bot_user_id }, person.token)
  return history(dm.channel.id, person.token)
}

describe("chat.scheduleMessage", () => {
  it("schedules a message and answers Slack's shape", async () => {
    const w = await workspace()
    const postAt = nowSeconds() + 3600
    const res = await schedule(w, { text: "Buenos días, 早上好, 좋은 아침", post_at: postAt })
    expect(res).toMatchObject({
      ok: true,
      channel: w.general,
      post_at: postAt,
      message: { type: "delayed_message", text: "Buenos días, 早上好, 좋은 아침", user: w.owner.id },
    })
    expect(res.scheduled_message_id).toMatch(/^Q[A-Z0-9]+$/)
    // The alarm is set by the time the method answers.
    expect(await alarmOf(w.teamId)).toBe(postAt * 1000)
    // Nothing is posted yet.
    expect((await history(w.general, w.owner.token)).map((m) => m.text)).not.toContain(res.message.text)
  })

  it("refuses times it can't keep, as Slack does", async () => {
    const w = await workspace()
    const now = nowSeconds()
    await expectError("chat.scheduleMessage", { channel: w.general, text: "x" }, w.owner.token, "invalid_time")
    await expectError(
      "chat.scheduleMessage",
      { channel: w.general, text: "x", post_at: "tomorrow" },
      w.owner.token,
      "invalid_time",
    )
    await expectError(
      "chat.scheduleMessage",
      { channel: w.general, text: "x", post_at: now - 10 },
      w.owner.token,
      "time_in_past",
    )
    await expectError(
      "chat.scheduleMessage",
      { channel: w.general, text: "x", post_at: now + 121 * 86_400 },
      w.owner.token,
      "time_too_far",
    )
    await expectError("chat.scheduleMessage", { channel: w.general, post_at: now + 60 }, w.owner.token, "no_text")
    await expectError(
      "chat.scheduleMessage",
      { channel: w.general, text: "x", post_at: now + 60, thread_ts: "1700000000.000001" },
      w.owner.token,
      "thread_not_found",
    )
    await expectError(
      "chat.scheduleMessage",
      { channel: "#nowhere", text: "x", post_at: now + 60 },
      w.owner.token,
      "channel_not_found",
    )
  })

  it("refuses a channel the poster can't write to", async () => {
    const w = await workspace()
    const bob = await w.addUser("bob")
    const { channel } = await ok<{ channel: { id: string } }>(
      "conversations.create",
      { name: "privada", is_private: true },
      w.owner.token,
    )
    await expectError(
      "chat.scheduleMessage",
      { channel: channel.id, text: "x", post_at: nowSeconds() + 60 },
      bob.token,
      "channel_not_found",
    )
    const sala = await room(w, bob)
    await ok("conversations.leave", { channel: sala }, bob.token)
    await expectError(
      "chat.scheduleMessage",
      { channel: sala, text: "x", post_at: nowSeconds() + 60 },
      bob.token,
      "not_in_channel",
    )
  })

  it("allows 30 in a channel within five minutes, then restricted_too_many", async () => {
    const w = await workspace()
    const postAt = nowSeconds() + 3600
    const db = env.DB
    await db.batch(
      Array.from({ length: 30 }, (_, i) =>
        db
          .prepare(
            `INSERT INTO scheduled_messages (id, team_id, channel_id, user_id, text, post_at, created, origin)
             VALUES (?, ?, ?, ?, 'x', ?, 0, 'https://campflare.test')`,
          )
          .bind(`QFULL${w.teamId}${i}`, w.teamId, w.general, w.owner.id, postAt + i),
      ),
    )
    await expectError(
      "chat.scheduleMessage",
      { channel: w.general, text: "one more", post_at: postAt + 100 },
      w.owner.token,
      "restricted_too_many",
    )
    // Outside the window it's fine.
    await schedule(w, { text: "later", post_at: postAt + 1000 })
  })

  it("wants chat:write", async () => {
    const w = await workspace()
    const token = await issueToken(env, {
      teamId: w.teamId,
      kind: "user",
      userId: w.owner.id,
      scopes: ["read"],
      label: "r",
    })
    await expectError(
      "chat.scheduleMessage",
      { channel: w.general, text: "x", post_at: nowSeconds() + 60 },
      token,
      "missing_scope",
    )
    await expectError("chat.scheduledMessages.list", {}, token, "missing_scope")
    await expectError(
      "chat.deleteScheduledMessage",
      { channel: w.general, scheduled_message_id: "Q1" },
      token,
      "missing_scope",
    )
  })
})

describe("chat.scheduledMessages.list", () => {
  it("lists the caller's own, soonest first, by channel, time and page", async () => {
    const w = await workspace()
    const bob = await w.addUser("bob")
    const { channel: other } = await ok<{ channel: { id: string } }>(
      "conversations.create",
      { name: "otro" },
      w.owner.token,
    )
    const base = nowSeconds() + 1000
    const late = await schedule(w, { text: "late", post_at: base + 300 })
    const soon = await schedule(w, { text: "soon", post_at: base })
    const elsewhere = await schedule(w, { channel: other.id, text: "elsewhere", post_at: base + 100 })
    await schedule(w, { text: "Bob's" }, bob.token)

    const all = await ok<Listed>("chat.scheduledMessages.list", {}, w.owner.token)
    expect(all.scheduled_messages.map((m) => m.id)).toEqual([
      soon.scheduled_message_id,
      elsewhere.scheduled_message_id,
      late.scheduled_message_id,
    ])
    expect(all.scheduled_messages[0]).toEqual({
      id: soon.scheduled_message_id,
      channel_id: w.general,
      post_at: base,
      date_created: expect.any(Number),
      text: "soon",
    })
    expect(all.response_metadata.next_cursor).toBe("")

    const inGeneral = await ok<Listed>("chat.scheduledMessages.list", { channel: "#general" }, w.owner.token)
    expect(inGeneral.scheduled_messages.map((m) => m.text)).toEqual(["soon", "late"])
    const window = await ok<Listed>(
      "chat.scheduledMessages.list",
      { oldest: base + 50, latest: base + 200 },
      w.owner.token,
    )
    expect(window.scheduled_messages.map((m) => m.text)).toEqual(["elsewhere"])

    const first = await ok<Listed>("chat.scheduledMessages.list", { limit: 2 }, w.owner.token)
    expect(first.scheduled_messages.map((m) => m.text)).toEqual(["soon", "elsewhere"])
    const second = await ok<Listed>(
      "chat.scheduledMessages.list",
      { limit: 2, cursor: first.response_metadata.next_cursor },
      w.owner.token,
    )
    expect(second.scheduled_messages.map((m) => m.text)).toEqual(["late"])
    expect(second.response_metadata.next_cursor).toBe("")
    await expectError("chat.scheduledMessages.list", { cursor: "nope" }, w.owner.token, "invalid_cursor")
    // A well-encoded cursor that doesn't hold a position.
    await expectError("chat.scheduledMessages.list", { cursor: btoa("next:soon") }, w.owner.token, "invalid_cursor")
    await expectError("chat.scheduledMessages.list", { oldest: "yesterday" }, w.owner.token, "invalid_arguments")
    await expectError("chat.scheduledMessages.list", { latest: "-5" }, w.owner.token, "invalid_arguments")
    const ts = await ok<Listed>("chat.scheduledMessages.list", { oldest: `${base}.000100` }, w.owner.token)
    expect(ts.scheduled_messages.map((m) => m.text)).toEqual(["elsewhere", "late"])

    expect(
      (await ok<Listed>("chat.scheduledMessages.list", {}, bob.token)).scheduled_messages.map((m) => m.text),
    ).toEqual(["Bob's"])
  })
})

describe("chat.deleteScheduledMessage", () => {
  it("deletes one of the caller's, and nothing else", async () => {
    const w = await workspace()
    const bob = await w.addUser("bob")
    const mine = await schedule(w, { text: "à bientôt" })
    const del = (args: Record<string, unknown>, token: string) => call("chat.deleteScheduledMessage", args, token)
    expect((await del({ channel: w.general, scheduled_message_id: mine.scheduled_message_id }, bob.token)).error).toBe(
      "invalid_scheduled_message_id",
    )
    const { channel: other } = await ok<{ channel: { id: string } }>(
      "conversations.create",
      { name: "otro" },
      w.owner.token,
    )
    expect(
      (await del({ channel: other.id, scheduled_message_id: mine.scheduled_message_id }, w.owner.token)).error,
    ).toBe("invalid_scheduled_message_id")
    expect((await del({ channel: w.general }, w.owner.token)).error).toBe("invalid_scheduled_message_id")
    await ok(
      "chat.deleteScheduledMessage",
      { channel: "#general", scheduled_message_id: mine.scheduled_message_id },
      w.owner.token,
    )
    expect((await ok<Listed>("chat.scheduledMessages.list", {}, w.owner.token)).scheduled_messages).toEqual([])
    expect(
      (await del({ channel: w.general, scheduled_message_id: mine.scheduled_message_id }, w.owner.token)).error,
    ).toBe("invalid_scheduled_message_id")
  })

  it("is refused while the message is being posted, and never posts one deleted before its time", async () => {
    const w = await workspace()
    const kept = await schedule(w, { text: "being posted" })
    const gone = await schedule(w, { text: "never posted" })
    // A runner holds the claim on one.
    await env.DB.prepare("UPDATE scheduled_messages SET claimed_until = ? WHERE id = ?")
      .bind(nowSeconds() + CLAIM_SECONDS, kept.scheduled_message_id)
      .run()
    await expectError(
      "chat.deleteScheduledMessage",
      { channel: w.general, scheduled_message_id: kept.scheduled_message_id },
      w.owner.token,
      "invalid_scheduled_message_id",
    )
    await ok(
      "chat.deleteScheduledMessage",
      { channel: w.general, scheduled_message_id: gone.scheduled_message_id },
      w.owner.token,
    )
    await env.DB.prepare("UPDATE scheduled_messages SET post_at = ?, claimed_until = NULL WHERE id = ?")
      .bind(nowSeconds() - 1, kept.scheduled_message_id)
      .run()
    await runDurableObjectAlarm(scheduler(w.teamId))
    const texts = (await history(w.general, w.owner.token)).map((m) => m.text)
    expect(texts).toContain("being posted")
    expect(texts).not.toContain("never posted")
  })
})

describe("firing", () => {
  it("posts as chat.postMessage would, when it's due, and re-arms for the next", async () => {
    const w = await workspace()
    const { cursor } = await ok<{ cursor: string }>("campflare.events.poll", {}, w.owner.token)
    const blocks = [{ type: "section", text: { type: "mrkdwn", text: "*Grüße*" } }]
    const due = await schedule(w, {
      text: "Grüße aus Köln",
      blocks,
      metadata: { event_type: "greeting", event_payload: {} },
    })
    const later = await schedule(w, { text: "later", post_at: nowSeconds() + 7200 })
    await makeDue(due.scheduled_message_id)
    expect(await runDurableObjectAlarm(scheduler(w.teamId))).toBe(true)

    const [posted] = await history(w.general, w.owner.token)
    expect(posted).toMatchObject({
      type: "message",
      user: w.owner.id,
      text: "Grüße aus Köln",
      blocks: [{ type: "section", block_id: expect.any(String) }],
      metadata: { event_type: "greeting" },
    })
    const listed = await ok<Listed>("chat.scheduledMessages.list", {}, w.owner.token)
    expect(listed.scheduled_messages.map((m) => m.id)).toEqual([later.scheduled_message_id])
    expect(await alarmOf(w.teamId)).toBe(later.post_at * 1000)

    // The message event, and the scheduled message leaving the list.
    const events = await eventually(async () => {
      const page = await ok<{ events: { event: Record<string, unknown> }[] }>(
        "campflare.events.poll",
        { cursor, wait: 1 },
        w.owner.token,
      )
      const types = page.events.map((e) => e.event.type)
      return types.includes("scheduled_message_removed") ? page.events.map((e) => e.event) : undefined
    })
    expect(events.map((e) => e.type)).toEqual([
      "scheduled_message_added",
      "scheduled_message_added",
      "message",
      "scheduled_message_removed",
    ])
    expect(events[0]).toMatchObject({ scheduled_message: { id: due.scheduled_message_id, text: "Grüße aus Köln" } })
    expect(events[3]).toMatchObject({
      type: "scheduled_message_removed",
      scheduled_message_id: due.scheduled_message_id,
      channel: w.general,
      reason: "posted",
      ts: posted!.ts,
    })
  })

  it("posts a thread reply, broadcast when asked", async () => {
    const w = await workspace()
    const head = await ok<{ ts: string }>("chat.postMessage", { channel: w.general, text: "hilo" }, w.owner.token)
    const reply = await schedule(w, { text: "respuesta", thread_ts: head.ts, reply_broadcast: true })
    await makeDue(reply.scheduled_message_id)
    await runDurableObjectAlarm(scheduler(w.teamId))
    const replies = await ok<History>("conversations.replies", { channel: w.general, ts: head.ts }, w.owner.token)
    expect(replies.messages.at(-1)).toMatchObject({
      text: "respuesta",
      subtype: "thread_broadcast",
      thread_ts: head.ts,
    })
  })

  it("posts a bot's as the bot, with app_mention for a bot it mentions", async () => {
    const w = await workspace()
    const poster = await w.addApp("Poster")
    const listener = await w.addApp("Listener")
    await call("conversations.invite", { channel: w.general, users: listener.botUserId }, w.owner.token)
    const link = await connect((await ok<{ url: string }>("apps.connections.open", {}, listener.appToken)).url)
    await link.next((f) => f.type === "hello")
    // A bot may schedule in a public channel it isn't in (chat:write.public), as it may post there.
    const res = await schedule(w, { text: `<@${listener.botUserId}> 你好`, username: "Cron" }, poster.botToken)
    expect(res.message).toMatchObject({ bot_id: poster.botId, subtype: "bot_message", username: "Cron" })
    const own = await ok<Listed>("chat.scheduledMessages.list", {}, poster.botToken)
    expect(own.scheduled_messages.map((m) => m.id)).toEqual([res.scheduled_message_id])
    expect((await ok<Listed>("chat.scheduledMessages.list", {}, w.owner.token)).scheduled_messages).toEqual([])

    await makeDue(res.scheduled_message_id)
    await runDurableObjectAlarm(scheduler(w.teamId))
    const [posted] = await history(w.general, w.owner.token)
    expect(posted).toMatchObject({ bot_id: poster.botId, username: "Cron", text: `<@${listener.botUserId}> 你好` })
    const mention = await link.next(
      (f) => f.type === "events_api" && (f.payload as { event: { type: string } }).event.type === "app_mention",
    )
    expect((mention.payload as { event: Record<string, unknown> }).event).toMatchObject({ bot_id: poster.botId })
    link.close()
  })

  it("posts once, however many runners fire at once", async () => {
    const w = await workspace()
    const res = await schedule(w, { text: "exactly once" })
    await makeDue(res.scheduled_message_id)
    const pending: Promise<unknown>[] = []
    await Promise.all([1, 2, 3].map(() => runDue(env, w.teamId, (p) => pending.push(p))))
    await runDurableObjectAlarm(scheduler(w.teamId))
    await Promise.allSettled(pending)
    const texts = (await history(w.general, w.owner.token)).map((m) => m.text)
    expect(texts.filter((t) => t === "exactly once")).toHaveLength(1)
  })

  it("leaves a claimed one to its runner, and takes it over once the claim runs out", async () => {
    const w = await workspace()
    const res = await schedule(w, { text: "taken over" })
    const now = nowSeconds()
    await env.DB.prepare("UPDATE scheduled_messages SET post_at = ?, claimed_until = ?, attempts = 1 WHERE id = ?")
      .bind(now - 1, now + CLAIM_SECONDS, res.scheduled_message_id)
      .run()
    const pending: Promise<unknown>[] = []
    // A runner that died mid-post holds the claim: nothing happens, and the next run is when it ends.
    expect(await runDue(env, w.teamId, (p) => pending.push(p), now)).toBe(now + CLAIM_SECONDS)
    expect((await history(w.general, w.owner.token)).map((m) => m.text)).not.toContain("taken over")
    expect(await runDue(env, w.teamId, (p) => pending.push(p), now + CLAIM_SECONDS)).toBeUndefined()
    await Promise.allSettled(pending)
    expect((await history(w.general, w.owner.token)).map((m) => m.text)).toContain("taken over")
  })

  it("retries after an unexpected error, then gives up and says so", async () => {
    const w = await workspace()
    const res = await schedule(w, { text: "unlucky" })
    // A broken row: building the request context throws, as an outage would, before anything is posted.
    await env.DB.prepare("UPDATE scheduled_messages SET post_at = ?, origin = 'not a url' WHERE id = ?")
      .bind(nowSeconds() - 1, res.scheduled_message_id)
      .run()
    const pending: Promise<unknown>[] = []
    const now = nowSeconds()
    expect(await runDue(env, w.teamId, (p) => pending.push(p), now)).toBe(now + CLAIM_SECONDS)
    expect(await rowOf(res.scheduled_message_id)).toMatchObject({ attempts: 1 })
    await env.DB.prepare("UPDATE scheduled_messages SET attempts = ?, claimed_until = NULL WHERE id = ?")
      .bind(MAX_ATTEMPTS - 1, res.scheduled_message_id)
      .run()
    expect(await runDue(env, w.teamId, (p) => pending.push(p), now)).toBeUndefined()
    await Promise.allSettled(pending)
    expect(await rowOf(res.scheduled_message_id)).toBeNull()
    expect((await history(w.general, w.owner.token)).map((m) => m.text)).not.toContain("unlucky")
  })
})

describe("when the poster lost access", () => {
  it("drops it and tells a person who left the channel, in a DM from the built-in bot", async () => {
    const w = await workspace()
    const bob = await w.addUser("bob")
    const sala = await room(w, bob)
    const res = await schedule(w, { channel: sala, text: "¿Seguís ahí?" }, bob.token)
    await ok("conversations.leave", { channel: sala }, bob.token)
    await makeDue(res.scheduled_message_id)
    await runDurableObjectAlarm(scheduler(w.teamId))
    expect((await history(sala, w.owner.token)).map((m) => m.text)).not.toContain("¿Seguís ahí?")
    expect(await rowOf(res.scheduled_message_id)).toBeNull()
    const [dm] = await systemDms(w, bob)
    expect(dm).toMatchObject({
      text: `Your scheduled message to <#${sala}> couldn't be sent (not_in_channel): ¿Seguís ahí?`,
      bot_id: expect.any(String),
    })
    // Its token's scopes never mattered; the built-in bot shows by its name.
    const info = await ok<{ user: { real_name: string; is_bot: boolean } }>(
      "users.info",
      { user: dm!.user as string },
      bob.token,
    )
    expect(info.user).toMatchObject({ real_name: "Campflare", is_bot: true })
  })

  it("drops one in an archived channel, and one whose thread is gone", async () => {
    const w = await workspace()
    const { channel } = await ok<{ channel: { id: string } }>(
      "conversations.create",
      { name: "archivo" },
      w.owner.token,
    )
    const archived = await schedule(w, { channel: channel.id, text: "archived" })
    await ok("conversations.archive", { channel: channel.id }, w.owner.token)
    const head = await ok<{ ts: string }>("chat.postMessage", { channel: w.general, text: "hilo" }, w.owner.token)
    const orphan = await schedule(w, { text: "orphan", thread_ts: head.ts })
    await ok("chat.delete", { channel: w.general, ts: head.ts }, w.owner.token)
    await makeDue(archived.scheduled_message_id)
    await makeDue(orphan.scheduled_message_id)
    await runDurableObjectAlarm(scheduler(w.teamId))
    const dms = (await systemDms(w, w.owner)).map((m) => m.text as string)
    expect(dms.some((t) => t.includes("(is_archived)"))).toBe(true)
    expect(dms.some((t) => t.includes("(thread_not_found)"))).toBe(true)
  })

  it("drops a deactivated person's silently", async () => {
    const w = await workspace()
    const bob = await w.addUser("bob")
    const res = await schedule(w, { text: "from a ghost" }, bob.token)
    await ok("campflare.users.deactivate", { user: bob.id }, w.owner.token)
    await makeDue(res.scheduled_message_id)
    await runDurableObjectAlarm(scheduler(w.teamId))
    expect((await history(w.general, w.owner.token)).map((m) => m.text)).not.toContain("from a ghost")
    expect(await rowOf(res.scheduled_message_id)).toBeNull()
    expect(
      await env.DB.prepare("SELECT COUNT(*) AS n FROM apps WHERE team_id = ? AND built_in IS NOT NULL")
        .bind(w.teamId)
        .first("n"),
    ).toBe(0)
  })

  it("posts even though the token that scheduled it was revoked", async () => {
    const w = await workspace()
    const token = await issueToken(env, {
      teamId: w.teamId,
      kind: "user",
      userId: w.owner.id,
      scopes: ["chat:write"],
      label: "agent",
    })
    const res = await schedule(w, { text: "outlives its token" }, token)
    await env.DB.prepare("UPDATE tokens SET revoked = 1 WHERE user_id = ? AND label = 'agent'").bind(w.owner.id).run()
    await makeDue(res.scheduled_message_id)
    await runDurableObjectAlarm(scheduler(w.teamId))
    expect((await history(w.general, w.owner.token)).map((m) => m.text)).toContain("outlives its token")
  })

  it("drops a bot's once it's removed from the channel, unless its token could post there anyway", async () => {
    const w = await workspace()
    const app = await w.addApp("Narrow")
    // A bot token without chat:write.public must be in the channel, then as at fire time.
    const narrow = await issueToken(env, {
      teamId: w.teamId,
      kind: "bot",
      userId: app.botUserId,
      appId: app.id,
      scopes: ["chat:write", "channels:read"],
      label: "narrow bot",
    })
    const { channel } = await ok<{ channel: { id: string } }>("conversations.create", { name: "bots" }, w.owner.token)
    await ok("conversations.invite", { channel: channel.id, users: app.botUserId }, w.owner.token)
    const kept = await schedule(w, { channel: channel.id, text: "with chat:write.public" }, app.botToken)
    const dropped = await schedule(w, { channel: channel.id, text: "without it" }, narrow)
    await ok("conversations.kick", { channel: channel.id, user: app.botUserId }, w.owner.token)
    await makeDue(kept.scheduled_message_id)
    await makeDue(dropped.scheduled_message_id)
    await runDurableObjectAlarm(scheduler(w.teamId))
    const texts = (await history(channel.id, w.owner.token)).map((m) => m.text)
    expect(texts).toContain("with chat:write.public")
    expect(texts).not.toContain("without it")
    expect(await rowOf(dropped.scheduled_message_id)).toBeNull()
  })
})

describe("the built-in bot", () => {
  it("can't be managed as an app, nor impersonated by an app of the same name", async () => {
    const w = await workspace()
    const bob = await w.addUser("bob")
    // Someone makes an app named like it first; the built-in bot is still its own.
    const fake = await w.addApp("Campflare")
    const sala = await room(w, bob)
    const res = await schedule(w, { channel: sala, text: "x" }, bob.token)
    await ok("conversations.leave", { channel: sala }, bob.token)
    await makeDue(res.scheduled_message_id)
    await runDurableObjectAlarm(scheduler(w.teamId))
    const [dm] = await systemDms(w, bob)
    expect(dm!.bot_id).not.toBe(fake.botId)
    const builtIn = await env.DB.prepare("SELECT id FROM apps WHERE team_id = ? AND built_in = 'campflare'")
      .bind(w.teamId)
      .first<{ id: string }>()
    await expectError("campflare.apps.info", { app: builtIn!.id }, w.owner.token, "app_not_found")
  })

  it("takes another handle when a person has its own", async () => {
    const w = await workspace()
    await w.addUser("campflare")
    const bob = await w.addUser("bob")
    const sala = await room(w, bob)
    const res = await schedule(w, { channel: sala, text: "x" }, bob.token)
    await ok("conversations.leave", { channel: sala }, bob.token)
    await makeDue(res.scheduled_message_id)
    await runDurableObjectAlarm(scheduler(w.teamId))
    const [dm] = await systemDms(w, bob)
    const info = await ok<{ user: { name: string } }>("users.info", { user: dm!.user as string }, bob.token)
    expect(info.user.name).toMatch(/^campflare-[a-z0-9]{4}$/)
  })
})
