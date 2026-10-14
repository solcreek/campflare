import { SELF } from "cloudflare:test"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  call,
  connect,
  expectError,
  fakeRequestUrls,
  ok,
  settle,
  validSignature,
  workspace,
  type Body,
  type RequestUrlHit,
  type Workspace,
} from "./helpers"

// Interactivity: clicks on an app's buttons reach the app as block_actions.

const URL = "https://app.example/interactive"
let urls: ReturnType<typeof fakeRequestUrls>

beforeEach(() => {
  urls = fakeRequestUrls()
})
afterEach(() => urls.restore())

type Settings = { app: { interactivity: { request_url: string | null } } }

describe("campflare.apps.setInteractivity", () => {
  it("sets and clears the Request URL, without a challenge", async () => {
    const w = await workspace()
    const app = await w.addApp("Clicky")
    const info = await ok<Settings>("campflare.apps.info", { app: app.id }, w.owner.token)
    expect(info.app.interactivity).toEqual({ request_url: null })
    const set = (request_url: string) =>
      ok<Settings>("campflare.apps.setInteractivity", { app: app.id, request_url }, w.owner.token)
    expect((await set(` ${URL} `)).app.interactivity).toEqual({ request_url: URL })
    expect((await set("http://localhost:3000/slack/events")).app.interactivity.request_url).toBe(
      "http://localhost:3000/slack/events",
    )
    expect((await set("")).app.interactivity).toEqual({ request_url: null })
    expect(urls.hits).toEqual([])
  })

  it("refuses a bad URL, a missing one, and someone else's app", async () => {
    const w = await workspace()
    const app = await w.addApp("Clicky")
    for (const request_url of ["http://app.example/x", "nope"]) {
      await expectError(
        "campflare.apps.setInteractivity",
        { app: app.id, request_url },
        w.owner.token,
        "invalid_arguments",
      )
    }
    await expectError("campflare.apps.setInteractivity", { app: app.id }, w.owner.token, "invalid_arguments")
    const bob = await w.addUser("bob")
    await expectError("campflare.apps.setInteractivity", { app: app.id, request_url: URL }, bob.token, "not_allowed")
  })
})

/** A message from an app's bot with an Approve/Reject actions block and feedback buttons. */
const BLOCKS = [
  { type: "section", block_id: "ask", text: { type: "mrkdwn", text: "Open the pull request?" } },
  {
    type: "actions",
    block_id: "decide",
    elements: [
      {
        type: "button",
        action_id: "approve",
        text: { type: "plain_text", text: "Approve" },
        value: "pr-42",
        style: "primary",
      },
      { type: "button", action_id: "reject", text: { type: "plain_text", text: "Reject" }, style: "danger" },
      {
        type: "button",
        action_id: "docs",
        text: { type: "plain_text", text: "Docs" },
        url: "https://docs.example/pr",
      },
    ],
  },
  {
    type: "context_actions",
    block_id: "rate",
    elements: [
      {
        type: "feedback_buttons",
        action_id: "feedback",
        positive_button: {
          text: { type: "plain_text", text: "Good" },
          value: "up",
          accessibility_label: "Good answer",
        },
        negative_button: { text: { type: "plain_text", text: "Bad" }, value: "down" },
      },
    ],
  },
]

/** A workspace with an app, its button message in #general, and Bob, who'll click. */
async function setup({ url = URL as string | null } = {}) {
  const w = await workspace()
  const app = await w.addApp("Clicky")
  const bob = await w.addUser("bob")
  if (url) await ok("campflare.apps.setInteractivity", { app: app.id, request_url: url }, w.owner.token)
  const posted = await ok<{ ts: string }>(
    "chat.postMessage",
    { channel: w.general, text: "Open the pull request?", blocks: BLOCKS },
    app.botToken,
    { json: true },
  )
  const click = (args: Record<string, unknown> = {}, token = bob.token) =>
    call<{ delivered?: string }>(
      "campflare.blocks.action",
      { channel: w.general, ts: posted.ts, action_id: "approve", ...args },
      token,
    )
  return { w, app, bob, ts: posted.ts, click }
}

const isAction = (h: RequestUrlHit) => h.body?.type === "block_actions"

/** POSTs an app's answer to a response_url, as Bolt's respond() does (JSON). */
async function respond(url: string, body: Record<string, unknown>) {
  const res = await SELF.fetch(
    new Request(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
  )
  return { status: res.status, body: (await res.json()) as Body }
}

describe("campflare.blocks.action over HTTP", () => {
  it("POSTs block_actions to the Interactivity Request URL, form-encoded and signed, in Slack's shape", async () => {
    const { w, app, bob, ts, click } = await setup()
    expect(await click()).toEqual({ ok: true, delivered: "http" })
    const hit = await urls.next(isAction)
    expect(hit.url).toBe(URL)
    expect(hit.headers.get("content-type")).toBe("application/x-www-form-urlencoded")
    expect(hit.raw.startsWith("payload=")).toBe(true)
    expect(await validSignature(hit, app.signingSecret)).toBe(true)
    expect(hit.body).toEqual({
      type: "block_actions",
      user: { id: bob.id, username: "bob", name: "bob", team_id: w.teamId },
      api_app_id: app.id,
      token: "",
      container: { type: "message", message_ts: ts, channel_id: w.general, is_ephemeral: false },
      trigger_id: expect.stringMatching(/^\d{10}\.\d{10}\.[0-9a-f]{32}$/),
      team: { id: w.teamId, domain: expect.any(String) },
      enterprise: null,
      is_enterprise_install: false,
      channel: { id: w.general, name: "general" },
      message: expect.objectContaining({
        type: "message",
        ts,
        text: "Open the pull request?",
        bot_id: app.botId,
        app_id: app.id,
        user: app.botUserId,
        blocks: BLOCKS,
      }),
      state: { values: {} },
      response_url: expect.stringMatching(/^https:\/\/campflare\.test\/actions\/[\w-]+\.[0-9a-f]{32}$/),
      actions: [
        {
          type: "button",
          block_id: "decide",
          action_id: "approve",
          text: { type: "plain_text", text: "Approve" },
          value: "pr-42",
          style: "primary",
          action_ts: expect.stringMatching(/^\d{10}\.\d{6}$/),
        },
      ],
    })
  })

  it("describes the element as stored: a link button's url, a feedback button's text and value", async () => {
    const { click } = await setup()
    expect((await click({ action_id: "docs", block_id: "decide" })).ok).toBe(true)
    expect((await urls.next(isAction)).body.actions).toEqual([
      {
        type: "button",
        block_id: "decide",
        action_id: "docs",
        text: { type: "plain_text", text: "Docs" },
        url: "https://docs.example/pr",
        action_ts: expect.any(String),
      },
    ])
    expect((await click({ action_id: "feedback", value: "down" })).ok).toBe(true)
    expect((await urls.next(isAction)).body.actions).toEqual([
      {
        type: "feedback_buttons",
        block_id: "rate",
        action_id: "feedback",
        text: { type: "plain_text", text: "Bad" },
        value: "down",
        action_ts: expect.any(String),
      },
    ])
    expect((await click({ action_id: "feedback", value: "sideways" })).error).toBe("invalid_value")
    expect((await click({ action_id: "feedback" })).error).toBe("invalid_value")
    expect((await click({ value: "pr-41" })).error).toBe("invalid_value")
    expect((await click({ action_id: "nope" })).error).toBe("action_not_found")
    expect((await click({ block_id: "rate" })).error).toBe("action_not_found")
    expect(urls.hits).toEqual([])
  })

  it("tells the clicker when the app can't be reached, and doesn't retry", async () => {
    const { click } = await setup()
    urls.answer = () => new Response("boom", { status: 500 })
    const failed = await click()
    expect(failed).toMatchObject({
      ok: false,
      error: "app_unreachable",
      response_metadata: { messages: ["[ERROR] the app didn't take it: its Interactivity Request URL answered 500"] },
    })
    urls.answer = () => {
      throw new DOMException("timed out", "TimeoutError")
    }
    expect((await click()).response_metadata).toEqual({
      messages: ["[ERROR] the app didn't take it: no answer from its Interactivity Request URL (http_timeout)"],
    })
    await settle()
    expect(urls.hits.filter(isAction)).toHaveLength(2)
  })

  it("doesn't count towards the event Request URL's delivery health", async () => {
    const { w, app, click } = await setup()
    urls.answer = () => new Response("boom", { status: 500 })
    expect((await click()).error).toBe("app_unreachable")
    const info = await ok<{ app: { event_subscriptions: { delivery: { attempts: number; last_attempt: unknown } } } }>(
      "campflare.apps.info",
      { app: app.id },
      w.owner.token,
    )
    expect(info.app.event_subscriptions.delivery).toMatchObject({ attempts: 0, last_attempt: null })
  })

  it("needs the app to have somewhere to send clicks", async () => {
    const { click } = await setup({ url: null })
    expect((await click()).error).toBe("interactivity_not_enabled")
  })

  it("lets only members of the conversation click, and only on an app's message", async () => {
    const { w, app, ts, click } = await setup()
    const carol = await w.addUser("carol")
    // A public channel Carol isn't in: she may read it, but not click.
    const { channel: dev } = await ok<{ channel: { id: string } }>(
      "conversations.create",
      { name: "dev" },
      w.owner.token,
    )
    const there = await ok<{ ts: string }>(
      "chat.postMessage",
      { channel: dev.id, text: "x", blocks: BLOCKS },
      app.botToken,
      { json: true },
    )
    expect((await click({ channel: dev.id, ts: there.ts }, carol.token)).error).toBe("not_in_channel")
    // A private channel is invisible to non-members.
    const { channel } = await ok<{ channel: { id: string } }>(
      "conversations.create",
      { name: "secret", is_private: true },
      w.owner.token,
    )
    await ok("conversations.invite", { channel: channel.id, users: app.botUserId }, w.owner.token)
    const secret = await ok<{ ts: string }>(
      "chat.postMessage",
      { channel: channel.id, text: "x", blocks: BLOCKS },
      app.botToken,
      { json: true },
    )
    expect((await click({ channel: channel.id, ts: secret.ts }, carol.token)).error).toBe("channel_not_found")
    // A person's message with buttons has no app behind it.
    const mine = await ok<{ ts: string }>(
      "chat.postMessage",
      { channel: w.general, text: "x", blocks: BLOCKS },
      w.owner.token,
      { json: true },
    )
    expect((await click({ ts: mine.ts })).error).toBe("not_interactive")
    expect((await click({ ts: "1.000001" })).error).toBe("message_not_found")
    expect((await click({}, app.botToken)).error).toBe("not_allowed_token_type")
    expect((await call("campflare.blocks.action", { channel: w.general, ts }, w.owner.token)).error).toBe(
      "invalid_arguments",
    )
    expect(urls.hits).toEqual([])
  })

  it("puts a reply's thread in the container", async () => {
    const { w, app, ts } = await setup()
    const reply = await ok<{ ts: string }>(
      "chat.postMessage",
      { channel: w.general, thread_ts: ts, text: "again", blocks: BLOCKS },
      app.botToken,
      { json: true },
    )
    await ok("campflare.blocks.action", { channel: w.general, ts: reply.ts, action_id: "approve" }, w.owner.token)
    expect((await urls.next(isAction)).body.container).toEqual({
      type: "message",
      message_ts: reply.ts,
      channel_id: w.general,
      is_ephemeral: false,
      thread_ts: ts,
    })
  })
})

describe("a streamed reply's feedback buttons", () => {
  it("get ids when the stream stops, and a click on one reaches the app", async () => {
    const { w, app, bob } = await setup()
    const question = await ok<{ ts: string }>("chat.postMessage", { channel: w.general, text: "why?" }, bob.token)
    const started = await ok<{ ts: string }>(
      "chat.startStream",
      {
        channel: w.general,
        thread_ts: question.ts,
        markdown_text: "Because.",
        recipient_user_id: bob.id,
        recipient_team_id: w.teamId,
      },
      app.botToken,
    )
    const feedback = {
      type: "feedback_buttons",
      positive_button: { text: { type: "plain_text", text: "Good" }, value: "up" },
      negative_button: { text: { type: "plain_text", text: "Bad" }, value: "down" },
    }
    const stopped = await ok<{
      message: { blocks: { type: string; block_id: string; elements?: { action_id: string }[] }[] }
    }>(
      "chat.stopStream",
      { channel: w.general, ts: started.ts, blocks: [{ type: "context_actions", elements: [feedback] }] },
      app.botToken,
    )
    const block = stopped.message.blocks.find((b) => b.type === "context_actions")!
    expect(block.block_id).toMatch(/^[A-Za-z0-9]{5}$/)
    const actionId = block.elements![0]!.action_id
    expect(actionId).toMatch(/^[A-Za-z0-9]{5}$/)
    await ok(
      "campflare.blocks.action",
      { channel: w.general, ts: started.ts, block_id: block.block_id, action_id: actionId, value: "up" },
      bob.token,
    )
    const hit = await urls.next(isAction)
    expect(hit.body).toMatchObject({
      container: { message_ts: started.ts, thread_ts: question.ts },
      actions: [{ type: "feedback_buttons", block_id: block.block_id, action_id: actionId, value: "up" }],
    })
  })
})

describe("campflare.blocks.action over Socket Mode", () => {
  it("sends an interactive envelope to a connected app instead, and waits for its ack", async () => {
    const { app, click } = await setup()
    const link = await connect((await ok<{ url: string }>("apps.connections.open", {}, app.appToken)).url)
    await link.next((f) => f.type === "hello")
    link.ws.addEventListener("message", (e: MessageEvent) => {
      const frame = JSON.parse(String(e.data)) as { type: string; envelope_id: string }
      if (frame.type === "interactive") link.ws.send(JSON.stringify({ envelope_id: frame.envelope_id }))
    })
    expect(await click()).toEqual({ ok: true, delivered: "socket" })
    const envelope = await link.next((f) => f.type === "interactive")
    expect(envelope).toEqual({
      envelope_id: expect.any(String),
      type: "interactive",
      accepts_response_payload: false,
      payload: expect.objectContaining({ type: "block_actions", api_app_id: app.id }),
    })
    expect(urls.hits).toEqual([])
    link.close()
  })

  it("is the clicker's error when the app doesn't ack in time, and isn't sent again", async () => {
    const { app, click } = await setup({ url: null })
    const link = await connect((await ok<{ url: string }>("apps.connections.open", {}, app.appToken)).url)
    await link.next((f) => f.type === "hello")
    expect(await click()).toMatchObject({
      error: "app_unreachable",
      response_metadata: {
        messages: ["[ERROR] the app didn't take it: its Socket Mode connection didn't acknowledge within 3 seconds"],
      },
    })
    await settle(100)
    expect(link.frames.filter((f) => f.type === "interactive")).toHaveLength(1)
    link.close()
  }, 10_000)
})

describe("response_url", () => {
  async function clicked() {
    const s = await setup()
    await s.click()
    const responseUrl = (await urls.next(isAction)).body.response_url as string
    return { ...s, responseUrl }
  }

  const history = async (w: Workspace, token = w.owner.token) =>
    (await ok<{ messages: Record<string, unknown>[] }>("conversations.history", { channel: w.general }, token)).messages

  it("replaces the original message", async () => {
    const { w, app, ts, responseUrl, bob } = await clicked()
    const rtm = await connect((await ok<{ url: string }>("rtm.connect", {}, bob.token)).url)
    const done = [{ type: "section", text: { type: "mrkdwn", text: "Approved by <@U1>" } }]
    expect(await respond(responseUrl, { replace_original: true, text: "Approved", blocks: done })).toEqual({
      status: 200,
      body: { ok: true },
    })
    const [latest] = await history(w)
    expect(latest).toMatchObject({ ts, text: "Approved", bot_id: app.botId, blocks: [{ type: "section" }] })
    // As on Slack, an app's replacement isn't an edit: no "(edited)".
    expect(latest).not.toHaveProperty("edited")
    const changed = await rtm.next((f) => f.subtype === "message_changed")
    expect(changed).toMatchObject({ message: { ts, text: "Approved" } })
    expect(changed.message).not.toHaveProperty("edited")
    rtm.close()
  })

  it("says something to the clicker alone by default, in the message's thread", async () => {
    const { w, app, ts, responseUrl, bob } = await clicked()
    const bobs = await connect((await ok<{ url: string }>("rtm.connect", {}, bob.token)).url)
    const owners = await connect((await ok<{ url: string }>("rtm.connect", {}, w.owner.token)).url)
    await bobs.next((f) => f.type === "hello")
    await owners.next((f) => f.type === "hello")
    expect((await respond(responseUrl, { text: "Only you see this" })).body).toEqual({ ok: true })
    expect(await bobs.next((f) => f.subtype === "ephemeral")).toMatchObject({
      type: "message",
      is_ephemeral: true,
      text: "Only you see this",
      bot_id: app.botId,
      channel: w.general,
    })
    await respond(responseUrl, { response_type: "ephemeral", text: "In a thread", thread_ts: ts })
    expect(await bobs.next((f) => f.subtype === "ephemeral")).toMatchObject({ thread_ts: ts })
    await settle()
    expect(owners.frames.filter((f) => f.subtype === "ephemeral")).toEqual([])
    expect((await history(w))[0]).toMatchObject({ ts })
    bobs.close()
    owners.close()
  })

  it("posts for everyone with response_type in_channel, and deletes the original", async () => {
    const { w, app, ts, responseUrl } = await clicked()
    await respond(responseUrl, { response_type: "in_channel", text: "Bob approved" })
    const [said] = await history(w)
    expect(said).toMatchObject({ text: "Bob approved", bot_id: app.botId })
    expect((await respond(responseUrl, { delete_original: "true" })).body).toEqual({ ok: true })
    expect((await history(w)).map((m) => m.ts)).not.toContain(ts)
    expect(await respond(responseUrl, { replace_original: true, text: "gone" })).toEqual({
      status: 400,
      body: { ok: false, error: "message_not_found" },
    })
  })

  it("accepts a form with a payload, and answers errors in content", async () => {
    const { w, responseUrl } = await clicked()
    const res = await SELF.fetch(
      new Request(responseUrl, {
        method: "POST",
        body: new URLSearchParams({ payload: JSON.stringify({ response_type: "in_channel", text: "via form" }) }),
      }),
    )
    expect(await res.json()).toEqual({ ok: true })
    expect((await history(w))[0]).toMatchObject({ text: "via form" })
    expect(await respond(responseUrl, { replace_original: true })).toEqual({
      status: 400,
      body: { ok: false, error: "no_text" },
    })
  })

  it("works 5 times, then no more", async () => {
    const { responseUrl } = await clicked()
    for (let i = 0; i < 5; i++) expect((await respond(responseUrl, { text: `${i}` })).status).toBe(200)
    expect(await respond(responseUrl, { text: "sixth" })).toEqual({
      status: 404,
      body: { ok: false, error: "used_url" },
    })
  })

  it("expires after 30 minutes, and can't be forged", async () => {
    const { responseUrl } = await clicked()
    const now = Date.now()
    const later = vi.spyOn(Date, "now").mockReturnValue(now + 31 * 60 * 1000)
    try {
      expect(await respond(responseUrl, { text: "late" })).toEqual({
        status: 404,
        body: { ok: false, error: "expired_url" },
      })
    } finally {
      later.mockRestore()
    }
    expect((await respond(responseUrl, { text: "in time" })).status).toBe(200)
    const forged = responseUrl.replace(/.$/, (c) => (c === "0" ? "1" : "0"))
    expect((await respond(forged, { text: "x" })).body.error).toBe("expired_url")
    // A WebSocket ticket is signed with the same key, but isn't a response_url.
    const { url } = await ok<{ url: string }>("rtm.connect", {}, (await workspace()).owner.token)
    const ticket = /ticket=([^&]+)/.exec(url)![1]!
    expect((await respond(`https://campflare.test/actions/${ticket}`, { text: "x" })).body.error).toBe("expired_url")
  })
})
