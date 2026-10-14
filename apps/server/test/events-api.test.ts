import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test"
import { env } from "cloudflare:workers"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import type { DeliveryHealth } from "../src/delivery-health"
import { MAX_RETRIES, type TeamHub } from "../src/hub"
import {
  connect,
  expectError,
  fakeRequestUrls,
  eventually,
  ok,
  settle,
  validSignature,
  workspace,
  type RequestUrlHit,
  type Workspace,
} from "./helpers"

// The Events API over HTTP: an app's Request URL gets signed event_callbacks.

const URL = "https://app.example/events"
let urls: ReturnType<typeof fakeRequestUrls>

beforeEach(() => {
  urls = fakeRequestUrls()
})
afterEach(() => urls.restore())

const eventOf = (h: RequestUrlHit) => h.body.event as Record<string, unknown>
const isEvent = (type: string, text?: string) => (h: RequestUrlHit) =>
  h.body.type === "event_callback" && eventOf(h).type === type && (text === undefined || eventOf(h).text === text)

const hub = (teamId: string) => env.HUB.get(env.HUB.idFromName(teamId))

/** Makes every pending delivery overdue and runs the hub's alarm, as if the wait had passed. */
async function expire(teamId: string) {
  await runInDurableObject(hub(teamId), async (_hub: TeamHub, state) => {
    state.storage.sql.exec("UPDATE unacked SET due = 0")
  })
  return runDurableObjectAlarm(hub(teamId))
}

async function pending(teamId: string) {
  return runInDurableObject(hub(teamId), async (_hub: TeamHub, state) =>
    state.storage.sql
      .exec<{ attempts: number; reason: string | null }>(
        "SELECT attempts, reason FROM unacked WHERE transport = 'http'",
      )
      .toArray(),
  )
}

/** A workspace with an app whose Request URL is set (and verified). */
async function subscribedApp(args: Record<string, unknown> = {}) {
  const w = await workspace()
  const app = await w.addApp("Hooked")
  await ok("campflare.apps.setEventSubscriptions", { app: app.id, request_url: URL, ...args }, w.owner.token)
  await urls.next((h) => h.body.type === "url_verification")
  return { w, app }
}

describe("signing secret and settings", () => {
  it("comes with the app, and its installer or an admin can read it", async () => {
    const w = await workspace()
    const app = await w.addApp("Hooked")
    expect(app.signingSecret).toMatch(/^[0-9a-f]{32}$/)
    const info = await ok<{ app: Record<string, unknown> }>("campflare.apps.info", { app: app.id }, w.owner.token)
    expect(info.app).toMatchObject({
      id: app.id,
      bot_user_id: app.botUserId,
      signing_secret: app.signingSecret,
      event_subscriptions: { request_url: null, events: null },
    })
    const bob = await w.addUser("bob")
    await expectError("campflare.apps.info", { app: app.id }, bob.token, "not_allowed")
    await expectError("campflare.apps.info", { app: "ANOPE" }, w.owner.token, "app_not_found")
    const admin = await w.addUser("ada", { is_admin: true })
    await ok("campflare.apps.info", { app: app.id }, admin.token)
    // Another workspace's admin doesn't find it.
    const other = await workspace()
    await expectError("campflare.apps.info", { app: app.id }, other.owner.token, "app_not_found")
  })
})

describe("campflare.apps.rotateSigningSecret", () => {
  it("switches every delivery to a new secret at once, retries of earlier events included", async () => {
    const { w, app } = await subscribedApp()
    // An event fails before the rotation, so its retry comes after.
    urls.answer = () => new Response("", { status: 500 })
    await ok("chat.postMessage", { channel: w.general, text: "before" }, w.owner.token)
    const before = await urls.next(isEvent("message", "before"))
    expect(await validSignature(before, app.signingSecret)).toBe(true)
    await settle()

    const rotated = await ok<{ app: { signing_secret: string } }>(
      "campflare.apps.rotateSigningSecret",
      { app: app.id },
      w.owner.token,
    )
    const secret = rotated.app.signing_secret
    expect(secret).toMatch(/^[0-9a-f]{32}$/)
    expect(secret).not.toBe(app.signingSecret)
    const info = await ok<{ app: { signing_secret: string } }>("campflare.apps.info", { app: app.id }, w.owner.token)
    expect(info.app.signing_secret).toBe(secret)

    urls.answer = () => new Response("")
    await expire(w.teamId)
    const retry = await urls.next(isEvent("message", "before"))
    expect(await validSignature(retry, secret)).toBe(true)
    expect(await validSignature(retry, app.signingSecret)).toBe(false)
    await ok("chat.postMessage", { channel: w.general, text: "after" }, w.owner.token)
    const after = await urls.next(isEvent("message", "after"))
    expect(await validSignature(after, secret)).toBe(true)
    expect(await validSignature(after, app.signingSecret)).toBe(false)
  })

  it("is for the installer or an admin", async () => {
    const w = await workspace()
    const app = await w.addApp("Hooked")
    const bob = await w.addUser("bob")
    await expectError("campflare.apps.rotateSigningSecret", { app: app.id }, bob.token, "not_allowed")
    await expectError("campflare.apps.rotateSigningSecret", { app: app.id }, app.botToken, "not_allowed_token_type")
    await expectError("campflare.apps.rotateSigningSecret", {}, w.owner.token, "app_not_found")
    const admin = await w.addUser("ada", { is_admin: true })
    await ok("campflare.apps.rotateSigningSecret", { app: app.id }, admin.token)
  })
})

describe("campflare.apps.setEventSubscriptions", () => {
  it("checks the Request URL with a signed url_verification challenge before saving it", async () => {
    const w = await workspace()
    const app = await w.addApp("Hooked")
    const res = await ok<{ app: { event_subscriptions: unknown } }>(
      "campflare.apps.setEventSubscriptions",
      { app: app.id, request_url: URL },
      w.owner.token,
    )
    expect(res.app.event_subscriptions).toMatchObject({ request_url: URL, events: null })
    const hit = await urls.next()
    expect(hit.url).toBe(URL)
    expect(hit.body).toEqual({ token: "", challenge: expect.any(String), type: "url_verification" })
    expect(hit.headers.get("content-type")).toBe("application/json")
    expect(await validSignature(hit, app.signingSecret)).toBe(true)
    expect(await validSignature(hit, "another secret")).toBe(false)
  })

  it("accepts the challenge echoed as plain text", async () => {
    const w = await workspace()
    const app = await w.addApp("Hooked")
    urls.answer = (h) => new Response(String(h.body.challenge))
    await ok("campflare.apps.setEventSubscriptions", { app: app.id, request_url: URL }, w.owner.token)
  })

  it("refuses a URL that doesn't echo the challenge, can't be reached, or isn't https", async () => {
    const w = await workspace()
    const app = await w.addApp("Hooked")
    const set = (url: string) =>
      expectError(
        "campflare.apps.setEventSubscriptions",
        { app: app.id, request_url: url },
        w.owner.token,
        "url_verification_failed",
      )
    urls.answer = () => new Response("nope")
    const wrong = await set(URL)
    expect(wrong.response_metadata).toEqual({
      messages: ["[ERROR] the Request URL answered 200 without echoing the challenge"],
    })
    urls.answer = () => new Response("{not json")
    await set(URL)
    urls.answer = () => new Response("gone", { status: 404 })
    await set(URL)
    urls.answer = () => {
      throw new TypeError("connection refused")
    }
    expect((await set(URL)).response_metadata).toEqual({
      messages: ["[ERROR] no answer from the Request URL (connection_failed)"],
    })
    urls.answer = () => {
      throw new DOMException("timed out", "TimeoutError")
    }
    expect((await set(URL)).response_metadata).toEqual({
      messages: ["[ERROR] no answer from the Request URL (http_timeout)"],
    })
    for (const url of ["http://app.example/events", "ftp://localhost/x", "not a url"]) {
      await expectError(
        "campflare.apps.setEventSubscriptions",
        { app: app.id, request_url: url },
        w.owner.token,
        "invalid_arguments",
      )
    }
    // Nothing was saved.
    const info = await ok<{ app: { event_subscriptions: unknown } }>(
      "campflare.apps.info",
      { app: app.id },
      w.owner.token,
    )
    expect(info.app.event_subscriptions).toMatchObject({ request_url: null, events: null })
  })

  it("allows http on localhost, for an app in development", async () => {
    const w = await workspace()
    const app = await w.addApp("Hooked")
    for (const url of ["http://localhost:3000/events", "http://127.0.0.1:3000/events"]) {
      await ok("campflare.apps.setEventSubscriptions", { app: app.id, request_url: url }, w.owner.token)
    }
  })

  it("sets events as a list or JSON, keeps what isn't given and clears what's empty", async () => {
    const { w, app } = await subscribedApp()
    type Settings = { app: { event_subscriptions: { request_url: string | null; events: string[] | null } } }
    const set = (args: Record<string, unknown>) =>
      ok<Settings>("campflare.apps.setEventSubscriptions", { app: app.id, ...args }, w.owner.token)
    expect((await set({ events: "app_mention, message.channels" })).app.event_subscriptions).toMatchObject({
      request_url: URL,
      events: ["app_mention", "message.channels"],
    })
    expect((await set({ events: '["reaction_added","reaction_added"]' })).app.event_subscriptions.events).toEqual([
      "reaction_added",
    ])
    const json = await ok<Settings>(
      "campflare.apps.setEventSubscriptions",
      { app: app.id, events: ["app_mention"] },
      w.owner.token,
      { json: true },
    )
    expect(json.app.event_subscriptions.events).toEqual(["app_mention"])
    expect((await set({ events: "" })).app.event_subscriptions).toMatchObject({ request_url: URL, events: null })
    expect((await set({ request_url: "" })).app.event_subscriptions).toMatchObject({ request_url: null, events: null })
    // Only the first set verified a URL.
    expect(urls.hits).toEqual([])
    await expectError("campflare.apps.setEventSubscriptions", { app: app.id }, w.owner.token, "invalid_arguments")
    for (const events of ["Not An Event", '["ok", 3]', '{"a":1}']) {
      await expectError(
        "campflare.apps.setEventSubscriptions",
        { app: app.id, events },
        w.owner.token,
        "invalid_arguments",
      )
    }
    const bob = await w.addUser("bob")
    await expectError("campflare.apps.setEventSubscriptions", { app: app.id, events: "" }, bob.token, "not_allowed")
  })
})

describe("delivery", () => {
  it("POSTs a signed event_callback for each event the app can see", async () => {
    const { w, app } = await subscribedApp()
    const posted = await ok<{ ts: string }>(
      "chat.postMessage",
      { channel: w.general, text: "over http" },
      w.owner.token,
    )
    const hit = await urls.next(isEvent("message"))
    expect(hit.url).toBe(URL)
    expect(await validSignature(hit, app.signingSecret)).toBe(true)
    expect(hit.headers.get("x-slack-retry-num")).toBeNull()
    expect(hit.body).toMatchObject({
      token: "",
      type: "event_callback",
      team_id: w.teamId,
      api_app_id: app.id,
      event_id: expect.stringMatching(/^Ev/),
      event_time: Math.floor(Number(posted.ts)),
      authorizations: [{ team_id: w.teamId, user_id: w.owner.id, is_bot: false }],
      event: { type: "message", text: "over http", ts: posted.ts, channel: w.general, channel_type: "channel" },
    })
    // Taken: nothing is left to retry.
    await settle()
    expect(await pending(w.teamId)).toEqual([])
  })

  it("sends app_mention too, and honours the subscribed event types", async () => {
    const { w, app } = await subscribedApp({ events: "app_mention" })
    const text = `<@${app.botUserId}> hello`
    await ok("chat.postMessage", { channel: w.general, text: "not for the app" }, w.owner.token)
    await ok("chat.postMessage", { channel: w.general, text }, w.owner.token)
    const hit = await urls.next(isEvent("app_mention"))
    expect(hit.body).toMatchObject({ authorizations: [{ user_id: app.botUserId, is_bot: true }] })
    expect(eventOf(hit)).toMatchObject({ text, user: w.owner.id, channel: w.general })
    await settle()
    expect(urls.hits).toEqual([])

    // message.im: messages in DMs only.
    await ok("campflare.apps.setEventSubscriptions", { app: app.id, events: "message.im" }, w.owner.token)
    const bob = await w.addUser("bob")
    const dm = await ok<{ channel: { id: string } }>("conversations.open", { users: bob.id }, w.owner.token)
    await ok("chat.postMessage", { channel: w.general, text: "in general" }, w.owner.token)
    await ok("chat.postMessage", { channel: dm.channel.id, text: "in a DM" }, w.owner.token)
    expect(eventOf(await urls.next(isEvent("message")))).toMatchObject({ text: "in a DM", channel_type: "im" })
    await settle()
    expect(urls.hits.filter(isEvent("message"))).toEqual([])
  })

  it("applies the subscription to Socket Mode too", async () => {
    const { w, app } = await subscribedApp({ events: "app_mention" })
    const link = await connect((await ok<{ url: string }>("apps.connections.open", {}, app.appToken)).url)
    await link.next((f) => f.type === "hello")
    await ok("chat.postMessage", { channel: w.general, text: `plain` }, w.owner.token)
    await ok("chat.postMessage", { channel: w.general, text: `<@${app.botUserId}>` }, w.owner.token)
    const frame = await link.next((f) => f.type === "events_api")
    expect((frame.payload as { event: { type: string } }).event.type).toBe("app_mention")
    await settle()
    expect(link.frames.filter((f) => f.type === "events_api")).toEqual([])
    link.close()
  })

  it("goes over Socket Mode instead while the app has a link", async () => {
    const { w, app } = await subscribedApp()
    const link = await connect((await ok<{ url: string }>("apps.connections.open", {}, app.appToken)).url)
    await link.next((f) => f.type === "hello")
    await ok("chat.postMessage", { channel: w.general, text: "socket" }, w.owner.token)
    await link.next((f) => f.type === "events_api")
    await settle()
    expect(urls.hits).toEqual([])
    link.close()
    await settle()
    await ok("chat.postMessage", { channel: w.general, text: "http again" }, w.owner.token)
    await urls.next(isEvent("message", "http again"))
  })

  it("only sends what the installer or bot can see, and stops when the URL is cleared", async () => {
    const { w, app } = await subscribedApp()
    const bob = await w.addUser("bob")
    const { channel } = await ok<{ channel: { id: string } }>(
      "conversations.create",
      { name: "bobs", is_private: true },
      bob.token,
    )
    await ok("chat.postMessage", { channel: channel.id, text: "private" }, bob.token)
    // RTM-only client state never goes to apps.
    await ok("conversations.mark", { channel: w.general, ts: "1700000000.000000" }, w.owner.token)
    await settle()
    expect(urls.hits).toEqual([])
    await ok("campflare.apps.setEventSubscriptions", { app: app.id, request_url: "" }, w.owner.token)
    await ok("chat.postMessage", { channel: w.general, text: "after" }, w.owner.token)
    await settle()
    expect(urls.hits).toEqual([])
  })
})

describe("retries", () => {
  it("retries a failed POST with X-Slack-Retry-Num and Reason, the same event, then gives up", async () => {
    const { w, app } = await subscribedApp()
    const failures: (() => Response)[] = [
      () => new Response("down", { status: 500 }),
      () => {
        throw new DOMException("timed out", "TimeoutError")
      },
      () => {
        throw new TypeError("connection refused")
      },
      () => new Response("still down", { status: 503 }),
    ]
    urls.answer = () => failures.shift()!()
    await ok("chat.postMessage", { channel: w.general, text: "flaky" }, w.owner.token)
    const first = await urls.next(isEvent("message", "flaky"))
    await settle()
    expect(await pending(w.teamId)).toEqual([{ attempts: 0, reason: "http_error" }])

    const reasons = ["http_error", "http_timeout", "connection_failed"]
    for (let retry = 1; retry <= MAX_RETRIES; retry++) {
      expect(await expire(w.teamId)).toBe(true)
      const hit = await urls.next(isEvent("message", "flaky"))
      expect(hit.headers.get("x-slack-retry-num")).toBe(String(retry))
      expect(hit.headers.get("x-slack-retry-reason")).toBe(reasons[retry - 1])
      expect(hit.raw).toBe(first.raw)
      expect(await validSignature(hit, app.signingSecret)).toBe(true)
    }
    // The last retry failed too: given up.
    expect(await pending(w.teamId)).toEqual([])
    await expire(w.teamId)
    expect(urls.hits).toEqual([])
  })

  it("stops retrying once taken, or when the app says X-Slack-No-Retry", async () => {
    const { w } = await subscribedApp()
    let fail = true
    urls.answer = () => (fail ? new Response("", { status: 500 }) : new Response(""))
    await ok("chat.postMessage", { channel: w.general, text: "once" }, w.owner.token)
    await urls.next(isEvent("message", "once"))
    fail = false
    await expire(w.teamId)
    expect((await urls.next(isEvent("message", "once"))).headers.get("x-slack-retry-num")).toBe("1")
    expect(await pending(w.teamId)).toEqual([])

    urls.answer = () => new Response("", { status: 500, headers: { "x-slack-no-retry": "1" } })
    await ok("chat.postMessage", { channel: w.general, text: "no retry" }, w.owner.token)
    await urls.next(isEvent("message", "no retry"))
    await settle()
    expect(await pending(w.teamId)).toEqual([])
  })

  it("drops pending retries when the Request URL is removed", async () => {
    const { w, app } = await subscribedApp()
    urls.answer = (h) =>
      h.body.type === "url_verification"
        ? Response.json({ challenge: h.body.challenge })
        : new Response("", { status: 500 })
    await ok("chat.postMessage", { channel: w.general, text: "orphan" }, w.owner.token)
    await urls.next(isEvent("message", "orphan"))
    await settle()
    await ok("campflare.apps.setEventSubscriptions", { app: app.id, request_url: "" }, w.owner.token)
    await expire(w.teamId)
    expect(await pending(w.teamId)).toEqual([])
    expect(urls.hits).toEqual([])
  })
})

/** event_subscriptions.delivery from campflare.apps.info. */
async function deliveryOf(app: { id: string }, token: string) {
  const info = await ok<{ app: { event_subscriptions: { delivery: DeliveryHealth } } }>(
    "campflare.apps.info",
    { app: app.id },
    token,
  )
  return info.app.event_subscriptions.delivery
}

/** Waits until the hub has counted `n` attempts in the window (it counts after the POST's answer). */
const counted = (w: Workspace, app: { id: string }, n: number) =>
  eventually(async () => (await deliveryOf(app, w.owner.token)).attempts === n)

/** Waits until delivery has been turned off, and returns the subscriptions. */
const turnedOff = (w: Workspace, app: { id: string }) =>
  eventually(async () => {
    const subs = await subscriptionsOf(app, w.owner.token)
    return subs.disabled ? subs : undefined
  })

describe("delivery health in campflare.apps.info", () => {
  it("reports the last attempt, the hour's attempts and failures, and pending retries", async () => {
    const w = await workspace()
    const app = await w.addApp("Hooked")
    expect(await deliveryOf(app, w.owner.token)).toEqual({
      last_attempt: null,
      window_minutes: 60,
      attempts: 0,
      failures: 0,
      pending: 0,
    })
    await ok("campflare.apps.setEventSubscriptions", { app: app.id, request_url: URL }, w.owner.token)
    await urls.next((h) => h.body.type === "url_verification")
    // url_verification isn't a delivery.
    expect((await deliveryOf(app, w.owner.token)).attempts).toBe(0)

    const before = Math.floor(Date.now() / 1000)
    await ok("chat.postMessage", { channel: w.general, text: "taken" }, w.owner.token)
    await urls.next(isEvent("message", "taken"))
    await counted(w, app, 1)
    expect(await deliveryOf(app, w.owner.token)).toEqual({
      last_attempt: { at: expect.any(Number), ok: true, status: 200, reason: null },
      window_minutes: 60,
      attempts: 1,
      failures: 0,
      pending: 0,
    })
    expect((await deliveryOf(app, w.owner.token)).last_attempt!.at).toBeGreaterThanOrEqual(before)

    urls.answer = () => new Response("down", { status: 503 })
    await ok("chat.postMessage", { channel: w.general, text: "refused" }, w.owner.token)
    await urls.next(isEvent("message", "refused"))
    await counted(w, app, 2)
    expect(await deliveryOf(app, w.owner.token)).toMatchObject({
      last_attempt: { ok: false, status: 503, reason: "http_error" },
      attempts: 2,
      failures: 1,
      pending: 1,
    })
    // Retries count as attempts.
    urls.answer = () => {
      throw new TypeError("connection refused")
    }
    await expire(w.teamId)
    await urls.next(isEvent("message", "refused"))
    expect(await deliveryOf(app, w.owner.token)).toMatchObject({
      last_attempt: { ok: false, status: 0, reason: "connection_failed" },
      attempts: 3,
      failures: 2,
      pending: 1,
    })

    // A new Request URL starts the count afresh; the last attempt stays.
    urls.answer = (h) =>
      h.body.type === "url_verification" ? Response.json({ challenge: h.body.challenge }) : new Response("")
    await ok("campflare.apps.setEventSubscriptions", { app: app.id, request_url: `${URL}/v2` }, w.owner.token)
    expect(await deliveryOf(app, w.owner.token)).toMatchObject({
      last_attempt: { reason: "connection_failed" },
      attempts: 0,
      failures: 0,
    })
    // The pending retry goes to the new URL; taken, it leaves nothing to fire in a later test.
    await expire(w.teamId)
    await urls.next(isEvent("message", "refused"))
    expect(await pending(w.teamId)).toEqual([])
  })

  it("forgets attempts older than the hour", async () => {
    const { w, app } = await subscribedApp()
    // Not retried, so nothing fires in a later test.
    urls.answer = () => new Response("", { status: 500, headers: { "x-slack-no-retry": "1" } })
    await ok("chat.postMessage", { channel: w.general, text: "old" }, w.owner.token)
    await urls.next(isEvent("message", "old"))
    await counted(w, app, 1)
    expect((await deliveryOf(app, w.owner.token)).failures).toBe(1)
    await runInDurableObject(hub(w.teamId), async (_hub: TeamHub, state) => {
      state.storage.sql.exec("UPDATE delivery_minutes SET minute = minute - 60")
    })
    expect(await deliveryOf(app, w.owner.token)).toMatchObject({ attempts: 0, failures: 0 })
  })
})

/** Counts attempts in the app's current minute, as if they had been made. */
async function seedAttempts(teamId: string, appId: string, attempts: number, failures: number) {
  await runInDurableObject(hub(teamId), async (_hub: TeamHub, state) => {
    state.storage.sql.exec(
      "INSERT INTO delivery_minutes (app_id, minute, attempts, failures) VALUES (?, ?, ?, ?)",
      appId,
      Math.floor(Date.now() / 60_000),
      attempts,
      failures,
    )
  })
}

type Subscriptions = {
  request_url: string | null
  events: string[] | null
  disabled: { at: number; reason: string } | null
  delivery: DeliveryHealth
}
const subscriptionsOf = async (app: { id: string }, token: string) =>
  (await ok<{ app: { event_subscriptions: Subscriptions } }>("campflare.apps.info", { app: app.id }, token)).app
    .event_subscriptions

/** The messages in the DM between the owner and the app's bot. */
async function dmFromBot(w: Workspace, app: { botUserId: string }) {
  const dm = await ok<{ channel: { id: string } }>("conversations.open", { users: app.botUserId }, w.owner.token)
  const history = await ok<{ messages: { text: string; user: string; bot_id?: string }[] }>(
    "conversations.history",
    { channel: dm.channel.id },
    w.owner.token,
  )
  return history.messages
}

/** One event the URL refuses. */
async function failOne(w: Workspace, text: string) {
  await ok("chat.postMessage", { channel: w.general, text }, w.owner.token)
  await urls.next(isEvent("message", text))
}

describe("turning off a failing Request URL", () => {
  const refuse = (h: RequestUrlHit) =>
    h.body.type === "url_verification"
      ? Response.json({ challenge: h.body.challenge })
      : new Response("", { status: 500 })

  it("waits for at least 20 attempts in the hour, then turns delivery off when over 95% failed", async () => {
    const { w, app } = await subscribedApp()
    urls.answer = refuse
    await seedAttempts(w.teamId, app.id, 18, 18)
    await failOne(w, "nineteenth")
    await counted(w, app, 19)
    expect((await subscriptionsOf(app, w.owner.token)).disabled).toBeNull()
    await failOne(w, "twentieth")
    const subs = await turnedOff(w, app)
    expect(subs).toMatchObject({
      request_url: URL,
      disabled: {
        at: expect.any(Number),
        reason: "100% of 20 attempts in the last 60 minutes failed; the last: HTTP 500",
      },
    })
    // The pending retries went with it, and the count starts afresh.
    expect(subs.delivery).toMatchObject({ attempts: 0, failures: 0, pending: 0, last_attempt: { status: 500 } })
    expect(await pending(w.teamId)).toEqual([])
    await expire(w.teamId)
    await ok("chat.postMessage", { channel: w.general, text: "not sent" }, w.owner.token)
    await settle()
    expect(urls.hits).toEqual([])
  })

  it("keeps delivering while at most 95% fail", async () => {
    const { w, app } = await subscribedApp()
    urls.answer = refuse
    await seedAttempts(w.teamId, app.id, 30, 27)
    await failOne(w, "ninety percent")
    await counted(w, app, 31)
    expect(await subscriptionsOf(app, w.owner.token)).toMatchObject({
      disabled: null,
      delivery: { attempts: 31, failures: 28 },
    })
    // A success never trips it, whatever came before.
    urls.answer = () => new Response("")
    await ok("chat.postMessage", { channel: w.general, text: "fine" }, w.owner.token)
    await urls.next(isEvent("message", "fine"))
    await expire(w.teamId)
    await urls.next(isEvent("message", "ninety percent"))
    expect(await pending(w.teamId)).toEqual([])
  })

  it("tells the installer in a DM from the app's bot, once, with how to turn it back on", async () => {
    const { w, app } = await subscribedApp()
    urls.answer = () => {
      throw new DOMException("timed out", "TimeoutError")
    }
    await seedAttempts(w.teamId, app.id, 25, 25)
    await failOne(w, "slow")
    await turnedOff(w, app)
    const messages = await eventually(async () => {
      const found = await dmFromBot(w, app)
      return found.length > 0 ? found : undefined
    })
    await settle()
    expect(await dmFromBot(w, app)).toHaveLength(1)
    expect(messages[0]).toMatchObject({ user: app.botUserId, bot_id: app.botId })
    expect(messages[0]!.text).toContain(`Campflare turned off event delivery for *Hooked* (${app.id})`)
    expect(messages[0]!.text).toContain(
      "100% of 26 attempts in the last 60 minutes failed; the last: no answer (http_timeout)",
    )
    expect(messages[0]!.text).toContain(`campflare admin app ${app.id} --request-url ${URL}`)
  })

  it("turns back on when the Request URL is set again and passes url_verification", async () => {
    const { w, app } = await subscribedApp()
    urls.answer = refuse
    await seedAttempts(w.teamId, app.id, 19, 19)
    await failOne(w, "last straw")
    await turnedOff(w, app)

    // Changing the events alone leaves it off; a URL that fails the challenge too.
    await ok("campflare.apps.setEventSubscriptions", { app: app.id, events: "message.channels" }, w.owner.token)
    expect((await subscriptionsOf(app, w.owner.token)).disabled).not.toBeNull()
    urls.answer = () => new Response("nope")
    await expectError(
      "campflare.apps.setEventSubscriptions",
      { app: app.id, request_url: URL },
      w.owner.token,
      "url_verification_failed",
    )
    expect((await subscriptionsOf(app, w.owner.token)).disabled).not.toBeNull()

    urls.answer = (h) =>
      h.body.type === "url_verification" ? Response.json({ challenge: h.body.challenge }) : new Response("")
    urls.hits.length = 0
    const res = await ok<{ app: { event_subscriptions: Subscriptions } }>(
      "campflare.apps.setEventSubscriptions",
      { app: app.id, request_url: URL },
      w.owner.token,
    )
    expect(res.app.event_subscriptions).toMatchObject({ request_url: URL, disabled: null })
    await urls.next((h) => h.body.type === "url_verification")
    await ok("chat.postMessage", { channel: w.general, text: "back on" }, w.owner.token)
    await urls.next(isEvent("message", "back on"))
  })

  it("is cleared by removing the Request URL, and leaves Socket Mode alone", async () => {
    const { w, app } = await subscribedApp()
    urls.answer = refuse
    await seedAttempts(w.teamId, app.id, 19, 19)
    await failOne(w, "down")
    await turnedOff(w, app)
    const link = await connect((await ok<{ url: string }>("apps.connections.open", {}, app.appToken)).url)
    await link.next((f) => f.type === "hello")
    await ok("chat.postMessage", { channel: w.general, text: "over the socket" }, w.owner.token)
    await link.next((f) => f.type === "events_api")
    link.close()
    await ok("campflare.apps.setEventSubscriptions", { app: app.id, request_url: "" }, w.owner.token)
    expect(await subscriptionsOf(app, w.owner.token)).toMatchObject({ request_url: null, disabled: null })
  })
})
