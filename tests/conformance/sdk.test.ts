import { SocketModeClient } from "@slack/socket-mode"
import { LogLevel, WebClient } from "@slack/web-api"
import { beforeAll, describe, expect, inject, it } from "vitest"

// The official Slack SDKs, unmodified, pointed at Campflare by URL alone.

const base = inject("baseUrl")
const slackApiUrl = `${base}/api/`
const client = (token: string) =>
  new WebClient(token, { slackApiUrl, logLevel: LogLevel.ERROR, retryConfig: { retries: 0 } })

let owner: WebClient
let ownerId: string
let general: string
let bob: { client: WebClient; id: string }
let app: { id: string; botToken: string; appToken: string; botUserId: string }

beforeAll(async () => {
  const anon = new WebClient(undefined, { slackApiUrl, logLevel: LogLevel.ERROR })
  const boot = (await anon.apiCall("campflare.bootstrap", {
    secret: "conformance",
    team_name: `Conformance ${Date.now()}`,
    user_name: "owner",
  })) as unknown as { token: string; user: { id: string }; general_channel: string }
  owner = client(boot.token)
  ownerId = boot.user.id
  general = boot.general_channel
  const b = (await owner.apiCall("campflare.users.create", { name: "bob", email: "bob@example.test" })) as unknown as {
    token: string
    user: { id: string }
  }
  bob = { client: client(b.token), id: b.user.id }
  const a = (await owner.apiCall("campflare.apps.create", { name: "Conformance Bot" })) as unknown as {
    app: { id: string; bot_user_id: string }
    bot_token: string
    app_token: string
  }
  app = { id: a.app.id, botToken: a.bot_token, appToken: a.app_token, botUserId: a.app.bot_user_id }
})

describe("@slack/web-api", () => {
  it("auth.test", async () => {
    const res = await owner.auth.test()
    expect(res).toMatchObject({ ok: true, user_id: ownerId, user: "owner" })
  })

  it("chat.postMessage, history, replies, update and delete", async () => {
    const posted = await owner.chat.postMessage({ channel: general, text: "hello from the SDK" })
    expect(posted.ok).toBe(true)
    expect(posted.message?.text).toBe("hello from the SDK")
    await bob.client.chat.postMessage({ channel: general, text: "a reply", thread_ts: posted.ts })
    const history = await owner.conversations.history({ channel: general, limit: 10 })
    expect(history.messages?.[0]).toMatchObject({ text: "hello from the SDK", reply_count: 1 })
    const replies = await owner.conversations.replies({ channel: general, ts: posted.ts! })
    expect(replies.messages?.map((m) => m.text)).toEqual(["hello from the SDK", "a reply"])
    await owner.chat.update({ channel: general, ts: posted.ts!, text: "edited" })
    const permalink = await owner.chat.getPermalink({ channel: general, message_ts: posted.ts! })
    expect(permalink.permalink).toContain(`/archives/${general}/`)
    await bob.client.reactions.add({ channel: general, timestamp: posted.ts!, name: "eyes" })
    const got = await owner.reactions.get({ channel: general, timestamp: posted.ts! })
    expect(got.message?.reactions).toEqual([{ name: "eyes", users: [bob.id], count: 1 }])
  })

  it("rejects with Slack's error codes", async () => {
    await expect(owner.chat.postMessage({ channel: "CNOPE", text: "x" })).rejects.toMatchObject({
      code: "slack_webapi_platform_error",
      data: { ok: false, error: "channel_not_found" },
    })
  })

  it("paginates users.list and conversations.list with the SDK's iterator", async () => {
    const names: string[] = []
    for await (const page of owner.paginate("users.list", { limit: 1 })) {
      names.push(...(page as unknown as { members: { name: string }[] }).members.map((m) => m.name))
    }
    expect(names.toSorted()).toEqual(["bob", "conformance-bot", "owner"])
    const channels: string[] = []
    for await (const page of owner.paginate("conversations.list", { limit: 1, types: "public_channel" })) {
      channels.push(...(page as unknown as { channels: { name: string }[] }).channels.map((c) => c.name))
    }
    expect(channels).toContain("general")
  })

  it("opens DMs and creates channels", async () => {
    const dm = await owner.conversations.open({ users: bob.id })
    expect(dm.channel?.id).toMatch(/^D/)
    const created = await owner.conversations.create({ name: `sdk-${Date.now()}` })
    await owner.conversations.invite({ channel: created.channel!.id!, users: bob.id })
    const members = await owner.conversations.members({ channel: created.channel!.id! })
    expect(members.members?.toSorted()).toEqual([ownerId, bob.id].toSorted())
  })

  it("uploads with filesUploadV2 (getUploadURLExternal + completeUploadExternal)", async () => {
    const res = await owner.filesUploadV2({
      channel_id: general,
      initial_comment: "a file",
      file: Buffer.from("campflare file body"),
      filename: "notes.txt",
      title: "Notes",
    })
    expect(res.ok).toBe(true)
    const fileId = (res as unknown as { files: { files: { id: string }[] }[] }).files[0]!.files[0]!.id
    const info = await bob.client.files.info({ file: fileId })
    expect(info.file).toMatchObject({ name: "notes.txt", title: "Notes", size: 19 })
    const body = await fetch(info.file!.url_private!, {
      headers: { authorization: `Bearer ${(bob.client as unknown as { token: string }).token}` },
    })
    expect(await body.text()).toBe("campflare file body")
  })

  it("search.messages", async () => {
    await owner.chat.postMessage({ channel: general, text: "needle in a haystack" })
    const res = await owner.search.messages({ query: "needle in:#general" })
    expect(res.messages?.matches?.[0]).toMatchObject({ text: "needle in a haystack", channel: { id: general } })
  })

  it("posts as a bot", async () => {
    const bot = client(app.botToken)
    const res = await bot.chat.postMessage({ channel: general, text: "beep" })
    expect(res.message).toMatchObject({ bot_id: expect.any(String), user: app.botUserId })
  })
})

describe("@slack/socket-mode", () => {
  it("receives events through SocketModeClient, quickly", async () => {
    const socket = new SocketModeClient({
      appToken: app.appToken,
      logLevel: LogLevel.ERROR,
      clientOptions: { slackApiUrl },
    })
    const received: { text: string; at: number }[] = []
    socket.on("message", async ({ event, ack }: { event: { text: string }; ack: () => Promise<void> }) => {
      await ack()
      received.push({ text: event.text, at: performance.now() })
    })
    await socket.start()

    // Latency: from just before chat.postMessage until the event arrives.
    const latencies: number[] = []
    for (let i = 0; i < 20; i++) {
      const start = performance.now()
      await owner.chat.postMessage({ channel: general, text: `ping ${i}` })
      while (!received.some((r) => r.text === `ping ${i}`)) await new Promise((r) => setTimeout(r, 1))
      latencies.push(received.find((r) => r.text === `ping ${i}`)!.at - start)
    }
    await socket.disconnect()
    latencies.sort((a, b) => a - b)
    const p50 = latencies[Math.floor(latencies.length / 2)]!
    const p95 = latencies[Math.floor(latencies.length * 0.95)]!
    console.log(`post → Socket Mode event, local wrangler dev: p50 ${p50.toFixed(1)} ms, p95 ${p95.toFixed(1)} ms`)
    expect(received).toHaveLength(20)
    expect(p95).toBeLessThan(500)
  })

  it("receives app_mention when a message mentions the app's bot", async () => {
    const socket = new SocketModeClient({
      appToken: app.appToken,
      logLevel: LogLevel.ERROR,
      clientOptions: { slackApiUrl },
    })
    const mentions: Record<string, unknown>[] = []
    socket.on("app_mention", async ({ event, ack }: { event: Record<string, unknown>; ack: () => Promise<void> }) => {
      await ack()
      mentions.push(event)
    })
    await socket.start()
    const text = `<@${app.botUserId}> are you there?`
    const posted = await bob.client.chat.postMessage({ channel: general, text })
    for (let i = 0; i < 200 && mentions.length === 0; i++) await new Promise((r) => setTimeout(r, 10))
    await socket.disconnect()
    expect(mentions).toEqual([
      expect.objectContaining({ type: "app_mention", user: bob.id, text, ts: posted.ts, channel: general }),
    ])
  })
})
