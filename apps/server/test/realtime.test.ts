import { SELF } from "cloudflare:test"
import { describe, expect, it } from "vitest"
import { connect, ok, settle, workspace } from "./helpers"

type Frame = Record<string, unknown>
const isEvent = (type: string, subtype?: string) => (f: Frame) => {
  const event = (f.type === "events_api" ? (f.payload as { event: Frame }).event : f) as Frame
  return event.type === type && (subtype === undefined || event.subtype === subtype)
}
const eventOf = (f: Frame) => (f.payload as { event: Frame }).event

describe("Socket Mode", () => {
  it("says hello and delivers events as acknowledged envelopes", async () => {
    const w = await workspace()
    const app = await w.addApp("Listener")
    const { url } = await ok<{ url: string }>("apps.connections.open", {}, app.appToken)
    expect(url).toMatch(/^wss:\/\/campflare\.test\/link\/\?ticket=/)
    const link = await connect(url)
    const hello = await link.next((f) => f.type === "hello")
    expect(hello).toMatchObject({ num_connections: 1, connection_info: { app_id: app.id } })

    const posted = await ok<{ ts: string }>("chat.postMessage", { channel: w.general, text: "live" }, w.owner.token)
    const envelope = await link.next(isEvent("message"))
    expect(envelope).toMatchObject({
      type: "events_api",
      accepts_response_payload: false,
      payload: {
        type: "event_callback",
        api_app_id: app.id,
        team_id: w.teamId,
        // The installer can see #general, so it's authorized as them.
        authorizations: [{ user_id: w.owner.id, is_bot: false, team_id: w.teamId }],
      },
    })
    expect(envelope.envelope_id).toEqual(expect.any(String))
    expect(eventOf(envelope)).toMatchObject({
      type: "message",
      text: "live",
      ts: posted.ts,
      channel: w.general,
      channel_type: "channel",
      user: w.owner.id,
    })
    link.ws.send(JSON.stringify({ envelope_id: envelope.envelope_id }))

    await ok("chat.update", { channel: w.general, ts: posted.ts, text: "edited" }, w.owner.token)
    expect(eventOf(await link.next(isEvent("message", "message_changed")))).toMatchObject({
      message: { text: "edited", ts: posted.ts },
      previous_message: { text: "live" },
    })
    await ok("reactions.add", { channel: w.general, timestamp: posted.ts, name: "tada" }, w.owner.token)
    expect(eventOf(await link.next(isEvent("reaction_added")))).toMatchObject({
      reaction: "tada",
      user: w.owner.id,
      item: { type: "message", channel: w.general, ts: posted.ts },
      item_user: w.owner.id,
    })
    await ok("reactions.remove", { channel: w.general, timestamp: posted.ts, name: "tada" }, w.owner.token)
    await link.next(isEvent("reaction_removed"))
    await ok("chat.delete", { channel: w.general, ts: posted.ts }, w.owner.token)
    expect(eventOf(await link.next(isEvent("message", "message_deleted")))).toMatchObject({ deleted_ts: posted.ts })
    await ok("dnd.setSnooze", { num_minutes: 5 }, w.owner.token)
    expect(eventOf(await link.next(isEvent("dnd_updated_user")))).toMatchObject({ user: w.owner.id })
    link.close()
  })

  it("only delivers what the installer or bot can see", async () => {
    const w = await workspace()
    const bob = await w.addUser("bob")
    const app = await w.addApp("Listener")
    const link = await connect((await ok<{ url: string }>("apps.connections.open", {}, app.appToken)).url)
    await link.next((f) => f.type === "hello")
    const { channel } = await ok<{ channel: { id: string } }>(
      "conversations.create",
      { name: "bobs", is_private: true },
      bob.token,
    )
    await ok("chat.postMessage", { channel: channel.id, text: "private" }, bob.token)
    await ok("chat.postMessage", { channel: w.general, text: "public" }, bob.token)
    const event = eventOf(await link.next(isEvent("message")))
    expect(event.text).toBe("public")
    await settle()
    expect(link.frames.filter(isEvent("message"))).toEqual([])

    // Inviting the bot lets it see the channel, authorized as the bot.
    await ok("conversations.invite", { channel: channel.id, users: app.botUserId }, bob.token)
    await ok("chat.postMessage", { channel: channel.id, text: "now visible" }, bob.token)
    const visible = await link.next((f) => isEvent("message")(f) && eventOf(f).text === "now visible")
    expect(visible).toMatchObject({ payload: { authorizations: [{ user_id: app.botUserId, is_bot: true }] } })
    link.close()
  })

  it("spreads events across an app's connections instead of copying them", async () => {
    const w = await workspace()
    const app = await w.addApp("Listener")
    const a = await connect((await ok<{ url: string }>("apps.connections.open", {}, app.appToken)).url)
    const b = await connect((await ok<{ url: string }>("apps.connections.open", {}, app.appToken)).url)
    expect(await b.next((f) => f.type === "hello")).toMatchObject({ num_connections: 2 })
    for (let i = 0; i < 4; i++) await ok("chat.postMessage", { channel: w.general, text: `m${i}` }, w.owner.token)
    await settle(150)
    const count = (l: typeof a) => l.frames.filter(isEvent("message")).length
    expect(count(a) + count(b)).toBe(4)
    expect(count(a)).toBeGreaterThan(0)
    expect(count(b)).toBeGreaterThan(0)
    a.close()
    b.close()
  })
})

describe("app_mention", () => {
  async function listening() {
    const w = await workspace()
    const app = await w.addApp("Helper")
    const link = await connect((await ok<{ url: string }>("apps.connections.open", {}, app.appToken)).url)
    await link.next((f) => f.type === "hello")
    return { w, app, link }
  }

  it("goes to the app alongside the message, in Slack's shape", async () => {
    const { w, app, link } = await listening()
    const text = `<@${app.botUserId}> what's new?`
    const posted = await ok<{ ts: string }>("chat.postMessage", { channel: w.general, text }, w.owner.token)
    const message = await link.next(isEvent("message"))
    const mention = await link.next(isEvent("app_mention"))
    expect(eventOf(message)).toMatchObject({ text, ts: posted.ts })
    expect(mention).toMatchObject({
      type: "events_api",
      payload: {
        type: "event_callback",
        api_app_id: app.id,
        team_id: w.teamId,
        authorizations: [{ user_id: app.botUserId, is_bot: true }],
      },
    })
    const event = eventOf(mention)
    expect(event).toMatchObject({
      type: "app_mention",
      user: w.owner.id,
      text,
      ts: posted.ts,
      channel: w.general,
      event_ts: posted.ts,
    })
    expect(event).not.toHaveProperty("channel_type")
    expect(event).not.toHaveProperty("thread_ts")
    // Its own event: a client deduplicates by event_id.
    expect((mention.payload as Frame).event_id).not.toBe((message.payload as Frame).event_id)
    link.close()
  })

  it("comes for a mention in a thread reply, with <@U|name>, and in a file share", async () => {
    const { w, app, link } = await listening()
    const head = await ok<{ ts: string }>("chat.postMessage", { channel: w.general, text: "a thread" }, w.owner.token)
    const reply = await ok<{ ts: string }>(
      "chat.postMessage",
      { channel: w.general, thread_ts: head.ts, text: `ask <@${app.botUserId}|helper>` },
      w.owner.token,
    )
    expect(eventOf(await link.next(isEvent("app_mention")))).toMatchObject({
      ts: reply.ts,
      thread_ts: head.ts,
      parent_user_id: w.owner.id,
    })

    const reserved = await ok<{ upload_url: string; file_id: string }>(
      "files.getUploadURLExternal",
      { filename: "a.txt", length: 1 },
      w.owner.token,
    )
    await SELF.fetch(reserved.upload_url, { method: "POST", body: "a" })
    await ok(
      "files.completeUploadExternal",
      { files: [{ id: reserved.file_id }], channel_id: w.general, initial_comment: `<@${app.botUserId}> see this` },
      w.owner.token,
    )
    expect(eventOf(await link.next(isEvent("app_mention")))).toMatchObject({
      files: [{ id: reserved.file_id }],
      text: `<@${app.botUserId}> see this`,
    })
    link.close()
  })

  it("doesn't come for edits, the bot's own messages, others' mentions or where the bot isn't", async () => {
    const { w, app, link } = await listening()
    const bob = await w.addUser("bob")
    const posted = await ok<{ ts: string }>("chat.postMessage", { channel: w.general, text: "plain" }, w.owner.token)
    await ok("chat.update", { channel: w.general, ts: posted.ts, text: `now <@${app.botUserId}>` }, w.owner.token)
    await link.next(isEvent("message", "message_changed"))
    await ok("chat.postMessage", { channel: w.general, text: `I am <@${app.botUserId}>` }, app.botToken)
    await ok("chat.postMessage", { channel: w.general, text: `hi <@${bob.id}>` }, w.owner.token)
    // The installer sees a channel the bot isn't in, so the message comes; the mention doesn't.
    const { channel } = await ok<{ channel: { id: string } }>(
      "conversations.create",
      { name: "no-bots", is_private: true },
      w.owner.token,
    )
    await ok("chat.postMessage", { channel: channel.id, text: `<@${app.botUserId}> here?` }, w.owner.token)
    await link.next((f) => isEvent("message")(f) && eventOf(f).channel === channel.id)
    await settle()
    expect(link.frames.filter(isEvent("app_mention"))).toEqual([])
    link.close()
  })

  it("isn't an RTM event", async () => {
    const w = await workspace()
    const app = await w.addApp("Helper")
    const rtm = await connect((await ok<{ url: string }>("rtm.connect", {}, w.owner.token)).url)
    await rtm.next((f) => f.type === "hello")
    await ok("chat.postMessage", { channel: w.general, text: `<@${app.botUserId}>` }, w.owner.token)
    await rtm.next(isEvent("message"))
    await settle()
    expect(rtm.frames.filter(isEvent("app_mention"))).toEqual([])
    rtm.close()
  })
})

describe("RTM", () => {
  it("delivers raw events a user can see, including read markers", async () => {
    const w = await workspace()
    const bob = await w.addUser("bob")
    const rtm = await ok<{ url: string; self: { id: string }; team: { id: string } }>("rtm.connect", {}, bob.token)
    expect(rtm).toMatchObject({ self: { id: bob.id, name: "bob" }, team: { id: w.teamId } })
    const link = await connect(rtm.url)
    await link.next((f) => f.type === "hello")

    const posted = await ok<{ ts: string; channel: string }>(
      "chat.postMessage",
      { channel: bob.id, text: "dm" },
      w.owner.token,
    )
    expect(await link.next(isEvent("im_created"))).toMatchObject({
      user: bob.id,
      channel: { id: posted.channel, user: w.owner.id },
    })
    expect(await link.next(isEvent("message"))).toMatchObject({
      text: "dm",
      channel: posted.channel,
      channel_type: "im",
    })
    await ok("conversations.mark", { channel: posted.channel, ts: posted.ts }, bob.token)
    expect(await link.next(isEvent("im_marked"))).toMatchObject({ channel: posted.channel, ts: posted.ts })
    await ok("chat.postEphemeral", { channel: w.general, user: bob.id, text: "psst" }, w.owner.token)
    expect(await link.next(isEvent("message", "ephemeral"))).toMatchObject({ text: "psst", is_ephemeral: true })
    const { channel } = await ok<{ channel: { id: string } }>("conversations.create", { name: "new" }, w.owner.token)
    expect(await link.next(isEvent("channel_created"))).toMatchObject({ channel: { id: channel.id, name: "new" } })
    await ok("conversations.join", { channel: channel.id }, bob.token)
    expect(await link.next(isEvent("member_joined_channel"))).toMatchObject({ user: bob.id, channel: channel.id })
    await ok("conversations.rename", { channel: channel.id, name: "renamed" }, w.owner.token)
    expect(await link.next(isEvent("channel_rename"))).toMatchObject({ channel: { name: "renamed" } })
    await ok("conversations.archive", { channel: channel.id }, w.owner.token)
    await link.next(isEvent("channel_archive"))
    await ok("conversations.unarchive", { channel: channel.id }, w.owner.token)
    await link.next(isEvent("channel_unarchive"))
    await ok("conversations.leave", { channel: channel.id }, bob.token)
    await link.next(isEvent("member_left_channel"))

    // A live RTM link reads as active presence.
    expect(await ok("users.getPresence", { user: bob.id }, w.owner.token)).toMatchObject({ presence: "active" })
    link.ws.send(JSON.stringify({ type: "ping", id: 7 }))
    expect(await link.next((f) => f.type === "pong")).toMatchObject({ reply_to: 7 })
    link.ws.send("not json")
    link.close()
  })

  it("announces file shares and deletions", async () => {
    const w = await workspace()
    const link = await connect((await ok<{ url: string }>("rtm.connect", {}, w.owner.token)).url)
    const reserved = await ok<{ upload_url: string; file_id: string }>(
      "files.getUploadURLExternal",
      { filename: "a.txt", length: 1 },
      w.owner.token,
    )
    await SELF.fetch(reserved.upload_url, { method: "POST", body: "a" })
    await ok(
      "files.completeUploadExternal",
      { files: [{ id: reserved.file_id }], channel_id: w.general },
      w.owner.token,
    )
    expect(await link.next(isEvent("file_shared"))).toMatchObject({ file_id: reserved.file_id, channel_id: w.general })
    await ok("files.delete", { file: reserved.file_id }, w.owner.token)
    expect(await link.next(isEvent("file_deleted"))).toMatchObject({
      file_id: reserved.file_id,
      channel_ids: [w.general],
    })
    link.close()
  })
})

describe("tickets", () => {
  it("refuses forged, reused and non-websocket links", async () => {
    const w = await workspace()
    const { url } = await ok<{ url: string }>("rtm.connect", {}, w.owner.token)
    const http = url.replace(/^ws/, "http")
    expect((await SELF.fetch(http.replace(/ticket=./, "ticket=x"), { headers: { upgrade: "websocket" } })).status).toBe(
      401,
    )
    expect(
      (await SELF.fetch("https://campflare.test/link/?ticket=abc.def", { headers: { upgrade: "websocket" } })).status,
    ).toBe(401)
    expect((await SELF.fetch(http)).status).toBe(426)
    const link = await connect(url)
    await link.next((f) => f.type === "hello")
    expect((await SELF.fetch(http, { headers: { upgrade: "websocket" } })).status).toBe(401)
    link.close()
  })
})
