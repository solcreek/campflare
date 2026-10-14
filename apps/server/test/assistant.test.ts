import { describe, expect, it } from "vitest"
import { call, connect, expectError, ok, settle, workspace } from "./helpers"

type Poll = { events: { event: Record<string, unknown> }[]; cursor: string }

describe("assistant.threads.setStatus", () => {
  it("sends the status to the conversation's clients as an RTM event, and an empty one to clear it", async () => {
    const w = await workspace()
    const app = await w.addApp("Thinker")
    const dm = await ok<{ channel: string; ts: string }>(
      "chat.postMessage",
      { channel: app.botUserId, text: "question" },
      w.owner.token,
    )
    const link = await connect((await ok<{ url: string }>("rtm.connect", {}, w.owner.token)).url)
    await link.next((f) => f.type === "hello")
    const socket = await connect((await ok<{ url: string }>("apps.connections.open", {}, app.appToken)).url)
    await socket.next((f) => f.type === "hello")

    const res = await call(
      "assistant.threads.setStatus",
      { channel_id: dm.channel, thread_ts: dm.ts, status: "is thinking…", loading_messages: ["Reading", "Writing"] },
      app.botToken,
    )
    expect(res).toEqual({ ok: true })
    expect(await link.next((f) => f.type === "assistant_thread_status_changed")).toMatchObject({
      channel: dm.channel,
      channel_type: "im",
      thread_ts: dm.ts,
      status: "is thinking…",
      loading_messages: ["Reading", "Writing"],
      user: app.botUserId,
      bot_id: app.botId,
      app_id: app.id,
      expires_in: 120,
    })
    await ok("assistant.threads.setStatus", { channel_id: dm.channel, thread_ts: dm.ts, status: "" }, app.botToken, {
      json: true,
    })
    const cleared = await link.next((f) => f.type === "assistant_thread_status_changed")
    expect(cleared).toMatchObject({ status: "" })
    expect(cleared.loading_messages).toBeUndefined()
    // Client state: apps don't get it over Socket Mode.
    await settle()
    expect(socket.frames.filter((f) => f.type === "events_api")).toEqual([])
    link.close()
    socket.close()
  })

  it("reaches the event log of the people in the conversation only", async () => {
    const w = await workspace()
    const app = await w.addApp("Thinker")
    const bob = await w.addUser("bob")
    const question = await ok<{ ts: string }>("chat.postMessage", { channel: w.general, text: "?" }, w.owner.token)
    const { channel } = await ok<{ channel: { id: string } }>(
      "conversations.create",
      { name: "private", is_private: true },
      w.owner.token,
    )
    await ok("conversations.invite", { channel: channel.id, users: app.botUserId }, w.owner.token)
    const secret = await ok<{ ts: string }>("chat.postMessage", { channel: channel.id, text: "?" }, w.owner.token)
    const bobStart = await ok<Poll>("campflare.events.poll", {}, bob.token)
    await ok(
      "assistant.threads.setStatus",
      { channel_id: channel.id, thread_ts: secret.ts, status: "is looking" },
      app.botToken,
    )
    // In a public channel the bot needn't be a member.
    await ok(
      "assistant.threads.setStatus",
      { channel_id: w.general, thread_ts: question.ts, status: "is thinking" },
      app.botToken,
    )
    await settle(150)
    const bobs = (await ok<Poll>("campflare.events.poll", { cursor: bobStart.cursor }, bob.token)).events.filter(
      (e) => e.event.type === "assistant_thread_status_changed",
    )
    expect(bobs.map((e) => e.event.status)).toEqual(["is thinking"])
  })

  it("refuses what Slack refuses", async () => {
    const w = await workspace()
    const app = await w.addApp("Thinker")
    const q = await ok<{ ts: string }>("chat.postMessage", { channel: w.general, text: "?" }, w.owner.token)
    const args = { channel_id: w.general, thread_ts: q.ts, status: "x" }
    await expectError("assistant.threads.setStatus", args, w.owner.token, "not_allowed_token_type")
    await expectError("assistant.threads.setStatus", { ...args, status: undefined }, app.botToken, "invalid_arguments")
    await expectError(
      "assistant.threads.setStatus",
      { ...args, loading_messages: Array.from({ length: 11 }, () => "x") },
      app.botToken,
      "invalid_arguments",
    )
    await expectError(
      "assistant.threads.setStatus",
      { ...args, loading_messages: [1] },
      app.botToken,
      "invalid_arguments",
    )
    await expectError(
      "assistant.threads.setStatus",
      { ...args, channel_id: undefined },
      app.botToken,
      "channel_not_found",
    )
    await expectError(
      "assistant.threads.setStatus",
      { ...args, channel_id: "CNOPE" },
      app.botToken,
      "channel_not_found",
    )
    await expectError(
      "assistant.threads.setStatus",
      { ...args, thread_ts: undefined },
      app.botToken,
      "invalid_thread_ts",
    )
    await expectError("assistant.threads.setStatus", { ...args, thread_ts: "soon" }, app.botToken, "invalid_thread_ts")
    await expectError(
      "assistant.threads.setStatus",
      { ...args, thread_ts: "1.000001" },
      app.botToken,
      "invalid_thread_ts",
    )
  })
})
