import { SocketModeClient } from "@slack/socket-mode"
import { LogLevel, WebClient } from "@slack/web-api"
import { beforeAll, describe, expect, inject, it } from "vitest"
import { sunsetPng } from "../../scripts/seed"

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

  it("reports missing_scope with what was needed, and reads the token's scopes", async () => {
    const made = (await owner.apiCall("campflare.tokens.create", { preset: "read", label: "sdk" })) as unknown as {
      token: string
    }
    const reader = client(made.token)
    const test = await reader.auth.test()
    expect(test.response_metadata?.scopes).toContain("channels:history")
    const error = await reader.chat.postMessage({ channel: general, text: "nein" }).catch((e: unknown) => e)
    expect(error).toMatchObject({
      code: "slack_webapi_platform_error",
      data: { ok: false, error: "missing_scope", needed: "chat:write" },
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

  it("pins.add, pins.list, pins.remove", async () => {
    const posted = await owner.chat.postMessage({ channel: general, text: "pin this · 置顶 · épingler" })
    await bob.client.pins.add({ channel: general, timestamp: posted.ts! })
    const listed = await owner.pins.list({ channel: general })
    expect(listed.items?.[0]).toMatchObject({
      type: "message",
      channel: general,
      created_by: bob.id,
      message: { ts: posted.ts, pinned_to: [general] },
    })
    await expect(owner.pins.add({ channel: general, timestamp: posted.ts! })).rejects.toMatchObject({
      data: { ok: false, error: "already_pinned" },
    })
    await owner.pins.remove({ channel: general, timestamp: posted.ts! })
    expect((await owner.pins.list({ channel: general })).items).toEqual([])
  })

  it("bookmarks.add, .edit, .list, .remove", async () => {
    const added = await owner.bookmarks.add({
      channel_id: general,
      type: "link",
      title: "Handbuch",
      link: "https://example.com/handbook",
      emoji: ":books:",
    })
    expect(added.bookmark).toMatchObject({ title: "Handbuch", link: "https://example.com/handbook", type: "link" })
    const id = added.bookmark!.id!
    const edited = await bob.client.bookmarks.edit({ channel_id: general, bookmark_id: id, title: "ハンドブック" })
    expect(edited.bookmark).toMatchObject({ id, title: "ハンドブック", last_updated_by_user_id: bob.id })
    expect((await bob.client.bookmarks.list({ channel_id: general })).bookmarks?.map((b) => b.id)).toEqual([id])
    await owner.bookmarks.remove({ channel_id: general, bookmark_id: id })
    expect((await owner.bookmarks.list({ channel_id: general })).bookmarks).toEqual([])
  })

  it("stars.add, stars.list, stars.remove", async () => {
    const posted = await owner.chat.postMessage({ channel: general, text: "save for later · 나중에" })
    await bob.client.stars.add({ channel: general, timestamp: posted.ts! })
    await bob.client.stars.add({ channel: general })
    const listed = await bob.client.stars.list({ limit: 10 })
    expect(listed.items?.map((i) => i.type).toSorted()).toEqual(["channel", "message"])
    expect(listed.items?.find((i) => i.type === "message")?.message).toMatchObject({ ts: posted.ts, is_starred: true })
    await bob.client.stars.remove({ channel: general, timestamp: posted.ts! })
    await bob.client.stars.remove({ channel: general })
    expect((await bob.client.stars.list({})).items).toEqual([])
  })

  it("posts as a bot", async () => {
    const bot = client(app.botToken)
    const res = await bot.chat.postMessage({ channel: general, text: "beep" })
    expect(res.message).toMatchObject({ bot_id: expect.any(String), user: app.botUserId })
  })

  it("chat.scheduleMessage, scheduledMessages.list and deleteScheduledMessage; the alarm posts it", async () => {
    const now = Math.floor(Date.now() / 1000)
    const later = await owner.chat.scheduleMessage({ channel: general, text: "à demain", post_at: now + 3600 })
    expect(later).toMatchObject({ ok: true, channel: general, post_at: now + 3600 })
    const soon = await owner.chat.scheduleMessage({ channel: general, text: "すぐに, 곧, pronto", post_at: now + 2 })
    const list = await owner.chat.scheduledMessages.list({ channel: general })
    expect(list.scheduled_messages?.map((m) => m.id)).toEqual([soon.scheduled_message_id, later.scheduled_message_id])
    await owner.chat.deleteScheduledMessage({ channel: general, scheduled_message_id: later.scheduled_message_id! })
    await expect(
      owner.chat.deleteScheduledMessage({ channel: general, scheduled_message_id: later.scheduled_message_id! }),
    ).rejects.toMatchObject({ data: { ok: false, error: "invalid_scheduled_message_id" } })
    await expect(owner.chat.scheduleMessage({ channel: general, text: "x", post_at: now - 60 })).rejects.toMatchObject({
      data: { ok: false, error: "time_in_past" },
    })
    // The Scheduler's alarm, in wrangler dev, posts it at its time.
    const deadline = Date.now() + 15_000
    let texts: (string | undefined)[] = []
    while (Date.now() < deadline) {
      texts = (await owner.conversations.history({ channel: general, limit: 5 })).messages?.map((m) => m.text) ?? []
      if (texts.includes("すぐに, 곧, pronto")) break
      await new Promise((r) => setTimeout(r, 250))
    }
    expect(texts).toContain("すぐに, 곧, pronto")
    expect((await owner.chat.scheduledMessages.list({ channel: general })).scheduled_messages).toEqual([])
  })

  it("reminders.add, info, list, complete and delete", async () => {
    const added = await bob.client.reminders.add({ text: "Rendre le livre", time: "in 2 hours" })
    expect(added.reminder).toMatchObject({ text: "Rendre le livre", user: bob.id, recurring: false, complete_ts: 0 })
    const id = added.reminder!.id!
    expect((await bob.client.reminders.info({ reminder: id })).reminder?.id).toBe(id)
    expect((await bob.client.reminders.list()).reminders?.map((r) => r.id)).toContain(id)
    await bob.client.reminders.complete({ reminder: id })
    expect((await bob.client.reminders.info({ reminder: id })).reminder?.complete_ts).toBeGreaterThan(0)
    await bob.client.reminders.delete({ reminder: id })
    await expect(bob.client.reminders.info({ reminder: id })).rejects.toMatchObject({
      data: { ok: false, error: "not_found" },
    })
    await expect(bob.client.reminders.add({ text: "x", time: "someday" })).rejects.toMatchObject({
      data: { ok: false, error: "cannot_parse" },
    })
  })

  it("streams a reply with chatStream (startStream, appendStream, stopStream) after setStatus", async () => {
    const bot = client(app.botToken)
    const question = await owner.chat.postMessage({ channel: general, text: "what's new?" })
    const thread_ts = question.ts!
    const status = await bot.assistant.threads.setStatus({ channel_id: general, thread_ts, status: "is thinking…" })
    expect(status.ok).toBe(true)

    // The SDK buffers markdown and flushes it as chunks once buffer_size is reached.
    const streamer = bot.chatStream({
      channel: general,
      thread_ts,
      recipient_user_id: ownerId,
      recipient_team_id: (await owner.auth.test()).team_id!,
      buffer_size: 8,
    })
    expect(await streamer.append({ markdown_text: "Hi" })).toBeNull()
    const started = await streamer.append({ markdown_text: " there, **you**." })
    expect(started).toMatchObject({ ok: true, channel: general, ts: expect.any(String) })
    await streamer.append({ markdown_text: " More" })
    const feedback = [{ type: "context", elements: [{ type: "mrkdwn", text: "Was this helpful?" }] }]
    const stopped = await streamer.stop({ markdown_text: " soon.", blocks: feedback })
    expect(stopped).toMatchObject({
      ok: true,
      ts: streamer.ts,
      message: {
        text: "Hi there, **you**. More soon.",
        blocks: [{ type: "markdown", text: "Hi there, **you**. More soon." }, ...feedback],
        streaming_state: "completed",
      },
    })
    await expect(streamer.append({ markdown_text: "late" })).rejects.toThrow("stream state is completed")

    // The methods themselves, with Slack's errors.
    const direct = await bot.chat.startStream({
      channel: general,
      thread_ts,
      markdown_text: "Direct",
      recipient_user_id: ownerId,
      recipient_team_id: (await owner.auth.test()).team_id!,
    })
    await bot.chat.appendStream({ channel: general, ts: direct.ts!, markdown_text: " stream" })
    await expect(
      bot.chat.appendStream({ channel: general, ts: direct.ts!, chunks: [{ type: "markdown_text", text: "x" }] }),
    ).rejects.toMatchObject({ data: { error: "streaming_mode_mismatch" } })
    const done = await bot.chat.stopStream({ channel: general, ts: direct.ts! })
    expect(done.message).toMatchObject({ text: "Direct stream", streaming_state: "completed" })
    await expect(bot.chat.stopStream({ channel: general, ts: direct.ts! })).rejects.toMatchObject({
      data: { error: "message_not_in_streaming_state" },
    })
    await expect(
      bot.chat.startStream({ channel: general, thread_ts, markdown_text: "who for?" }),
    ).rejects.toMatchObject({ data: { error: "missing_recipient_user_id" } })

    const replies = await owner.conversations.replies({ channel: general, ts: thread_ts })
    expect(replies.messages?.map((m) => m.text)).toEqual([
      "what's new?",
      "Hi there, **you**. More soon.",
      "Direct stream",
    ])
  })

  it("streams tasks and a plan with chatStream, until a person stops it: stopped_by_user", async () => {
    const bot = client(app.botToken)
    const question = await owner.chat.postMessage({ channel: general, text: "plan it?" })
    const thread_ts = question.ts!
    const streamer = bot.chatStream({
      channel: general,
      thread_ts,
      recipient_user_id: ownerId,
      recipient_team_id: (await owner.auth.test()).team_id!,
      task_display_mode: "plan",
    })
    // Chunks flush at once, buffer or not.
    const started = await streamer.append({
      chunks: [
        { type: "plan_update", title: "Plan de travail" },
        { type: "task_update", id: "read", title: "Lire", status: "in_progress" },
      ],
    })
    expect(started).toMatchObject({ ok: true, ts: streamer.ts })
    await streamer.append({
      chunks: [
        { type: "task_update", id: "read", title: "Lire", status: "complete", output: "読んだ" },
        { type: "task_update", id: "write", title: "Escribir", status: "in_progress" },
      ],
    })
    const [, reply] = (await owner.conversations.replies({ channel: general, ts: thread_ts })).messages!
    expect(reply).toMatchObject({
      streaming_state: "in_progress",
      blocks: [
        {
          type: "plan",
          title: "Plan de travail",
          tasks: [
            { type: "task_card", task_id: "read", status: "complete", output: { type: "rich_text" } },
            { type: "task_card", task_id: "write", status: "in_progress" },
          ],
        },
      ],
    })

    // The person it answers stops it from their client.
    const stopped = (await owner.apiCall("campflare.chat.stopStream", { channel: general, ts: streamer.ts })) as {
      message?: { streaming_state?: string }
    }
    expect(stopped.message?.streaming_state).toBe("completed")
    await expect(streamer.append({ chunks: [{ type: "markdown_text", text: "more" }] })).rejects.toMatchObject({
      data: { error: "stopped_by_user" },
    })
  })

  it("users.setPhoto and users.deletePhoto", async () => {
    const png = await sunsetPng(300, 200)
    const set = await bob.client.users.setPhoto({ image: Buffer.from(png), crop_x: 50, crop_y: 0, crop_w: 200 })
    expect(set.ok).toBe(true)
    const profile = (await bob.client.users.profile.get({})).profile!
    expect(profile.is_custom_image).toBe(true)
    const small = await fetch(profile.image_72!)
    expect(small.status).toBe(200)
    expect(small.headers.get("content-type")).toBe("image/png")
    expect(new Uint8Array(await (await fetch(profile.image_original!)).arrayBuffer())).toEqual(png)
    await bob.client.users.deletePhoto({})
    expect((await bob.client.users.profile.get({})).profile?.image_72).toBe(`${base}/avatars/${bob.id}?s=72`)
  })

  it("emoji.list and admin.emoji.*: custom emoji, aliases, rename and remove", async () => {
    const png = await sunsetPng(48, 48)
    // admin.emoji.add takes a URL; an upload is campflare.emoji.add, multipart like users.setPhoto.
    const added = (await bob.client.apiCall("campflare.emoji.add", {
      name: "sdk-sunset",
      image: Buffer.from(png),
    })) as unknown as { emoji: { url: string } }
    expect(new Uint8Array(await (await fetch(added.emoji.url)).arrayBuffer())).toEqual(png)
    await owner.admin.emoji.addAlias({ name: "sdk-sun", alias_for: "sdk-sunset" })
    const listed = await owner.emoji.list({ include_categories: true })
    expect(listed.emoji).toMatchObject({ "sdk-sunset": added.emoji.url, "sdk-sun": "alias:sdk-sunset" })
    expect(listed.categories?.[0]?.name).toBe("smileys_people")
    const admin = await bob.client.admin.emoji.list({})
    expect(admin.emoji?.["sdk-sunset"]).toMatchObject({ url: added.emoji.url, uploaded_by: bob.id })
    await bob.client.admin.emoji.rename({ name: "sdk-sunset", new_name: "sdk-dusk" })
    expect((await owner.emoji.list()).emoji).toMatchObject({ "sdk-dusk": added.emoji.url, "sdk-sun": "alias:sdk-dusk" })
    // The URL fetch is refused by the SSRF guard before any network: a local name.
    await expect(owner.admin.emoji.add({ name: "sdk-local", url: "https://localhost/e.png" })).rejects.toMatchObject({
      data: { error: "error_bad_upload" },
    })
    await expect(owner.admin.emoji.add({ name: "thumbsup", url: "https://example.com/e.png" })).rejects.toMatchObject({
      data: { error: "error_name_taken_i18n" },
    })
    await owner.admin.emoji.remove({ name: "sdk-dusk" })
    const after = (await owner.emoji.list()).emoji ?? {}
    expect(Object.keys(after).filter((n) => n.startsWith("sdk-"))).toEqual([])
    expect((await fetch(added.emoji.url)).status).toBe(404)
  })

  it("usergroups: create, members, list, update, disable and enable", async () => {
    const created = await owner.usergroups.create({ name: "Soporte · サポート", handle: "soporte", channels: general })
    const id = created.usergroup!.id!
    expect(created.usergroup).toMatchObject({ handle: "soporte", prefs: { channels: [general] } })
    const filled = await owner.usergroups.users.update({ usergroup: id, users: `${ownerId},${bob.id}` })
    expect(filled.usergroup?.users?.toSorted()).toEqual([ownerId, bob.id].toSorted())
    expect((await bob.client.usergroups.users.list({ usergroup: id })).users?.toSorted()).toEqual(
      [ownerId, bob.id].toSorted(),
    )
    const listed = await bob.client.usergroups.list({ include_users: true, include_count: true })
    expect(listed.usergroups?.find((g) => g.id === id)).toMatchObject({ user_count: 2 })
    const updated = await owner.usergroups.update({ usergroup: id, description: "Hilfe · 도움" })
    expect(updated.usergroup?.description).toBe("Hilfe · 도움")
    expect((await owner.usergroups.disable({ usergroup: id })).usergroup?.date_delete).toBeGreaterThan(0)
    expect((await owner.usergroups.list()).usergroups?.some((g) => g.id === id)).toBe(false)
    expect((await owner.usergroups.enable({ usergroup: id })).usergroup?.date_delete).toBe(0)
    await expect(owner.usergroups.create({ name: "Other", handle: "soporte" })).rejects.toMatchObject({
      data: { error: "handle_already_exists" },
    })
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
