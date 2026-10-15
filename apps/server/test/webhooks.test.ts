import { env, SELF } from "cloudflare:test"
import { describe, expect, it } from "vitest"
import { call, expectError, ok, workspace } from "./helpers"

// Incoming webhooks: a URL that posts in one conversation as an app's bot.

type Webhook = {
  id: string
  app_id: string
  channel: string
  channel_name?: string
  label: string
  created_by: string
  created: number
  last_used: number | null
  url?: string
}

async function setup() {
  const w = await workspace()
  const app = await w.addApp("Alerts")
  const made = await ok<{ webhook: Webhook & { url: string } }>(
    "campflare.apps.createWebhook",
    { app: app.id, channel: "#general", label: "CI 通知" },
    w.owner.token,
  )
  return { w, app, hook: made.webhook }
}

/** POSTs to a webhook URL as JSON (or as given): Slack's status and plain-text answer. */
async function post(url: string, body: unknown, init: { form?: boolean; type?: string } = {}) {
  const headers: Record<string, string> = {
    "content-type": init.type ?? (init.form ? "application/x-www-form-urlencoded" : "application/json"),
  }
  const raw = init.form
    ? new URLSearchParams({ payload: JSON.stringify(body) }).toString()
    : typeof body === "string"
      ? body
      : JSON.stringify(body)
  const res = await SELF.fetch(new Request(url, { method: "POST", headers, body: raw }))
  return { status: res.status, text: await res.text(), retryAfter: res.headers.get("retry-after") }
}

const latest = async (token: string, channel: string, limit = 1) =>
  (await ok<{ messages: Record<string, unknown>[] }>("conversations.history", { channel, limit }, token)).messages

describe("campflare.apps.createWebhook", () => {
  it("answers a URL once, and lists the webhook without it", async () => {
    const { w, app, hook } = await setup()
    expect(hook).toEqual({
      id: expect.stringMatching(/^H[0-9A-Z]{10}$/),
      app_id: app.id,
      channel: w.general,
      channel_name: "general",
      label: "CI 通知",
      created_by: w.owner.id,
      created: expect.any(Number),
      last_used: null,
      url: expect.stringMatching(/^https:\/\/campflare\.test\/services\/[0-9a-f]{48}$/),
    })
    const listed = await ok<{ webhooks: Webhook[] }>("campflare.apps.webhooks.list", { app: app.id }, w.owner.token)
    const { url: _url, ...rest } = hook
    expect(listed.webhooks).toEqual([rest])
    // Only the hash is kept.
    const row = await env.DB.prepare("SELECT hash FROM webhooks WHERE id = ?").bind(hook.id).first<{ hash: string }>()
    expect(row!.hash).not.toContain(hook.url.split("/").pop())
  })

  it("is the installer's or an admin's, for a conversation the bot can post in", async () => {
    const { w, app } = await setup()
    const bob = await w.addUser("bob")
    await expectError("campflare.apps.createWebhook", { app: app.id, channel: w.general }, bob.token, "not_allowed")
    await expectError("campflare.apps.webhooks.list", { app: app.id }, bob.token, "not_allowed")
    await expectError("campflare.apps.createWebhook", { app: "A0", channel: w.general }, w.owner.token, "app_not_found")
    const secret = await ok<{ channel: { id: string } }>(
      "conversations.create",
      { name: "privé", is_private: true },
      w.owner.token,
    )
    await expectError(
      "campflare.apps.createWebhook",
      { app: app.id, channel: secret.channel.id },
      w.owner.token,
      "not_in_channel",
    )
    await ok("conversations.invite", { channel: secret.channel.id, users: app.botUserId }, w.owner.token)
    await ok("campflare.apps.createWebhook", { app: app.id, channel: secret.channel.id }, w.owner.token)
    // Bob can't name a private conversation he isn't in, even with an admin's say.
    const theirs = await ok<{ channel: { id: string } }>(
      "conversations.create",
      { name: "x", is_private: true },
      bob.token,
    )
    await expectError(
      "campflare.apps.createWebhook",
      { app: app.id, channel: theirs.channel.id },
      w.owner.token,
      "channel_not_found",
    )
    const reader = (await ok<{ token: string }>("campflare.tokens.create", { preset: "write" }, w.owner.token)).token
    await expectError("campflare.apps.createWebhook", { app: app.id, channel: w.general }, reader, "missing_scope")
  })
})

describe("POST /services/<secret>", () => {
  it("posts Slack's webhook body as the app's bot, and answers ok", async () => {
    const { w, app, hook } = await setup()
    const blocks = [{ type: "section", block_id: "s", text: { type: "mrkdwn", text: "*Build* passed" } }]
    expect(await post(hook.url, { text: "Build passed: déploiement 완료", blocks, unfurl_links: false })).toEqual({
      status: 200,
      text: "ok",
      retryAfter: null,
    })
    const [message] = await latest(w.owner.token, w.general)
    expect(message).toMatchObject({
      text: "Build passed: déploiement 완료",
      bot_id: app.botId,
      user: app.botUserId,
      app_id: app.id,
      blocks,
    })
    const listed = await ok<{ webhooks: Webhook[] }>("campflare.apps.webhooks.list", { app: app.id }, w.owner.token)
    expect(listed.webhooks[0]!.last_used).toEqual(expect.any(Number))
  })

  it("takes a form's payload, raw JSON without a content type, attachments, a thread and a username", async () => {
    const { w, hook } = await setup()
    expect((await post(hook.url, { text: "from a form" }, { form: true })).text).toBe("ok")
    expect((await post(hook.url, JSON.stringify({ text: "untyped" }), { type: "text/plain" })).text).toBe("ok")
    const [parent] = await latest(w.owner.token, w.general)
    expect(parent!.text).toBe("untyped")
    const attachments = [{ color: "good", text: "Tous les tests passent" }]
    expect(
      (await post(hook.url, { attachments, thread_ts: parent!.ts, username: "CI ビルド", channel: "#elsewhere" })).text,
    ).toBe("ok")
    const replies = await ok<{ messages: Record<string, unknown>[] }>(
      "conversations.replies",
      { channel: w.general, ts: parent!.ts },
      w.owner.token,
    )
    expect(replies.messages[1]).toMatchObject({
      attachments: [expect.objectContaining(attachments[0])],
      username: "CI ビルド",
    })
  })

  it("answers Slack's errors with Slack's statuses", async () => {
    const { w, app, hook } = await setup()
    expect(await post(hook.url, "not json")).toMatchObject({ status: 400, text: "invalid_payload" })
    expect(await post(hook.url, [1, 2])).toMatchObject({ status: 400, text: "invalid_payload" })
    expect(await post(hook.url, "text=hi", { type: "application/x-www-form-urlencoded" })).toMatchObject({
      status: 400,
      text: "invalid_payload",
    })
    expect(await post(hook.url, {})).toMatchObject({ status: 400, text: "no_text" })
    expect(await post(hook.url, { text: "x", blocks: "nope" })).toMatchObject({ status: 400, text: "invalid_blocks" })
    expect(await post(hook.url, { text: "x", thread_ts: "1.000001" })).toMatchObject({
      status: 400,
      text: "thread_not_found",
    })
    expect(await post(`${hook.url}0`, { text: "x" })).toMatchObject({ status: 404, text: "no_service" })

    // A private conversation the bot left, an archived one, a deactivated bot.
    const room = await ok<{ channel: { id: string } }>(
      "conversations.create",
      { name: "salle", is_private: true },
      w.owner.token,
    )
    await ok("conversations.invite", { channel: room.channel.id, users: app.botUserId }, w.owner.token)
    const inRoom = await ok<{ webhook: { url: string } }>(
      "campflare.apps.createWebhook",
      { app: app.id, channel: room.channel.id },
      w.owner.token,
    )
    await ok("conversations.kick", { channel: room.channel.id, user: app.botUserId }, w.owner.token)
    expect(await post(inRoom.webhook.url, { text: "x" })).toMatchObject({ status: 404, text: "channel_not_found" })
    const open = await ok<{ channel: { id: string } }>("conversations.create", { name: "ouvert" }, w.owner.token)
    const inOpen = await ok<{ webhook: { url: string } }>(
      "campflare.apps.createWebhook",
      { app: app.id, channel: open.channel.id },
      w.owner.token,
    )
    await ok("conversations.archive", { channel: open.channel.id }, w.owner.token)
    expect(await post(inOpen.webhook.url, { text: "x" })).toMatchObject({ status: 410, text: "channel_is_archived" })
    await ok("campflare.users.deactivate", { user: app.botUserId }, w.owner.token)
    expect(await post(hook.url, { text: "x" })).toMatchObject({ status: 403, text: "action_prohibited" })
  })

  it("is rate limited per webhook: a burst, then about one a second, with Retry-After", async () => {
    const { w, app, hook } = await setup()
    const other = await ok<{ webhook: { url: string } }>(
      "campflare.apps.createWebhook",
      { app: app.id, channel: w.general },
      w.owner.token,
    )
    const answers: number[] = []
    for (let i = 0; i < 11; i++) answers.push((await post(hook.url, { text: `n° ${i}` })).status)
    expect(answers.slice(0, 10)).toEqual(Array(10).fill(200))
    const limited = await post(hook.url, { text: "too many" })
    expect(limited).toEqual({ status: 429, text: "rate_limited", retryAfter: "1" })
    // Another webhook has its own bucket.
    expect((await post(other.webhook.url, { text: "mine" })).status).toBe(200)
    // A second later there's a token again.
    await env.DB.prepare("UPDATE webhooks SET bucket_at = bucket_at - 1000 WHERE id = ?").bind(hook.id).run()
    expect((await post(hook.url, { text: "again" })).status).toBe(200)
  })

  it("stops at once when revoked", async () => {
    const { w, app, hook } = await setup()
    const bob = await w.addUser("bob")
    await expectError("campflare.apps.webhooks.revoke", { webhook: hook.id }, bob.token, "not_allowed")
    expect(await call("campflare.apps.webhooks.revoke", { webhook: hook.id }, w.owner.token)).toEqual({ ok: true })
    expect(await post(hook.url, { text: "x" })).toMatchObject({ status: 404, text: "no_service" })
    await expectError("campflare.apps.webhooks.revoke", { webhook: hook.id }, w.owner.token, "webhook_not_found")
    expect(
      (await ok<{ webhooks: Webhook[] }>("campflare.apps.webhooks.list", { app: app.id }, w.owner.token)).webhooks,
    ).toEqual([])
  })
})
