import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test"
import { env } from "cloudflare:workers"
import { afterEach, describe, expect, it } from "vitest"
import { issueToken } from "../src/api/auth"
import type { TeamHub } from "../src/hub"
import { isPushService, MAX_SUBSCRIPTIONS } from "../src/methods/push"
import { decode } from "../src/push/base64url"
import { PUSH_PER_MINUTE, PUSH_RETRY_DELAYS_MS } from "../src/push/deliver"
import { importPublic } from "../src/push/keys"
import { call, connect, eventually, expectError, ok, settle, workspace } from "./helpers"
import { browserSubscription, fakePushService, type FakeSubscription } from "./push-service"

interface Listed {
  id: string
  label: string
  service: string
  created: number
  last_used: number
}

let service: ReturnType<typeof fakePushService> | undefined
afterEach(() => {
  service?.restore()
  service = undefined
})

const subscribe = (token: string, sub: FakeSubscription, label = "Firefox on Linux") =>
  ok<{ subscription: Listed }>("campflare.push.subscribe", { subscription: sub, label }, token, { json: true })

const list = async (token: string) =>
  (await ok<{ subscriptions: Listed[] }>("campflare.push.list", {}, token)).subscriptions

const post = async (token: string, channel: string, text: string, extra: Record<string, unknown> = {}) =>
  (await ok<{ ts: string }>("chat.postMessage", { channel, text, ...extra }, token)).ts

const hubOf = (teamId: string) => env.HUB.get(env.HUB.idFromName(teamId))

/** Makes every pending push retry due and runs the hub's alarm. */
async function retryNow(teamId: string) {
  await runInDurableObject(hubOf(teamId), async (_hub: TeamHub, state) => {
    state.storage.sql.exec("UPDATE push_pending SET due = 0")
  })
  return runDurableObjectAlarm(hubOf(teamId))
}

const pendingRetries = (teamId: string) =>
  runInDurableObject(hubOf(teamId), async (_hub: TeamHub, state) =>
    state.storage.sql.exec<{ attempts: number; due: number }>("SELECT attempts, due FROM push_pending").toArray(),
  )

/** The pushes made: none, say, after a moment for the hub's after-response work. */
async function pushesAfterAMoment(s: ReturnType<typeof fakePushService>) {
  await settle(150)
  return s.hits
}

describe("campflare.push.vapidKey", () => {
  it("answers the public key with no token, as a browser needs it to subscribe", async () => {
    const res = await ok<{ key: string }>("campflare.push.vapidKey")
    expect(res.key).toBe(env.VAPID_PUBLIC_KEY)
    expect(decode(res.key)!.length).toBe(65)
  })
})

describe("push subscriptions", () => {
  it("subscribes, lists without the endpoint, updates a browser in place and unsubscribes", async () => {
    const w = await workspace()
    const firefox = await browserSubscription("updates.push.example")
    const chrome = await browserSubscription("fcm.example")
    const { subscription } = await subscribe(w.owner.token, firefox)
    expect(subscription).toEqual({
      id: expect.stringMatching(/^P[A-Z0-9]+$/),
      label: "Firefox on Linux",
      service: "updates.push.example",
      created: expect.any(Number),
      last_used: 0,
    })
    expect(JSON.stringify(subscription)).not.toContain(firefox.endpoint)
    // The keys may come one by one too, as a form.
    await ok(
      "campflare.push.subscribe",
      { endpoint: chrome.endpoint, p256dh: chrome.keys.p256dh, auth: chrome.keys.auth, label: "Chrome · 東京" },
      w.owner.token,
    )
    expect((await list(w.owner.token)).map((s) => s.label)).toEqual(["Chrome · 東京", "Firefox on Linux"])

    // The same browser again: one row, its new label, and when it was made stays.
    const again = await subscribe(w.owner.token, firefox, "Firefox en français")
    expect(again.subscription).toEqual({ ...subscription, label: "Firefox en français" })
    expect((await list(w.owner.token)).map((s) => s.label)).toEqual(["Chrome · 東京", "Firefox en français"])

    // By endpoint (what a browser knows), or by id.
    expect(await ok("campflare.push.unsubscribe", { endpoint: firefox.endpoint }, w.owner.token)).toMatchObject({
      removed: [subscription.id],
    })
    const [left] = await list(w.owner.token)
    await ok("campflare.push.unsubscribe", { id: left!.id }, w.owner.token)
    expect(await list(w.owner.token)).toEqual([])
    await expectError("campflare.push.unsubscribe", { id: left!.id }, w.owner.token, "subscription_not_found")
    await expectError("campflare.push.unsubscribe", {}, w.owner.token, "invalid_arguments")
  })

  it("keeps each person's own: nobody else lists or removes them", async () => {
    const w = await workspace()
    const bob = await w.addUser("bob")
    const { subscription } = await subscribe(bob.token, await browserSubscription())
    expect(await list(w.owner.token)).toEqual([])
    await expectError("campflare.push.unsubscribe", { id: subscription.id }, w.owner.token, "subscription_not_found")
    expect(await list(bob.token)).toHaveLength(1)
  })

  it("never takes over a browser someone else subscribed, here or in another workspace, until they let go", async () => {
    const a = await workspace()
    const b = await workspace()
    const bob = await a.addUser("bob")
    const sub = await browserSubscription()
    const { subscription } = await subscribe(a.owner.token, sub)
    for (const token of [bob.token, b.owner.token]) {
      const refused = await call("campflare.push.subscribe", { subscription: sub }, token, { json: true })
      expect(refused.error).toBe("endpoint_in_use")
    }
    expect(await list(a.owner.token)).toEqual([subscription])
    // Signing out there unsubscribes it; then it's free.
    await ok("campflare.push.unsubscribe", { endpoint: sub.endpoint }, a.owner.token)
    await subscribe(bob.token, sub)
    expect(await list(bob.token)).toHaveLength(1)
  })

  it("does nothing when a browser says again what it said (every load), keeping when it was last used", async () => {
    service = fakePushService()
    const w = await workspace()
    const sub = await browserSubscription()
    await subscribe(w.owner.token, sub)
    await ok("campflare.push.test", {}, w.owner.token)
    const [used] = await list(w.owner.token)
    expect(used!.last_used).toBeGreaterThan(0)
    const hubForgets = () =>
      runInDurableObject(hubOf(w.teamId), async (hub: TeamHub) => {
        const delivery = (hub as unknown as { push: { subscriptions?: unknown } }).push
        return delivery.subscriptions === undefined
      })
    // The hub has read the subscriptions (the test push doesn't go through it: a mention does).
    const bob = await w.addUser("bob")
    await post(bob.token, w.general, `<@${w.owner.id}> 確認`)
    await service.next()
    expect(await hubForgets()).toBe(false)
    expect((await subscribe(w.owner.token, sub)).subscription).toEqual(used)
    expect(await hubForgets()).toBe(false)
    // A new key is a change: written, created and last_used kept, and the hub reads again.
    const rotated = await browserSubscription()
    const changed = await subscribe(w.owner.token, { ...rotated, endpoint: sub.endpoint })
    expect(changed.subscription).toEqual(used)
    expect(await hubForgets()).toBe(true)
  })

  it(`keeps the newest ${MAX_SUBSCRIPTIONS} of a person's`, async () => {
    const w = await workspace()
    for (let i = 0; i <= MAX_SUBSCRIPTIONS; i++)
      await subscribe(w.owner.token, await browserSubscription(), `device ${i}`)
    const labels = (await list(w.owner.token)).map((s) => s.label)
    expect(labels).toHaveLength(MAX_SUBSCRIPTIONS)
    expect(labels).not.toContain("device 0")
    expect(labels[0]).toBe(`device ${MAX_SUBSCRIPTIONS}`)
  })

  it("knows the browsers' push services, and those PUSH_SERVICE_HOSTS adds", () => {
    expect(isPushService("fcm.googleapis.com")).toBe(true)
    expect(isPushService("updates.push.services.mozilla.com")).toBe(true)
    expect(isPushService("web.push.apple.com")).toBe(true)
    expect(isPushService("wns2-db5p.notify.windows.com")).toBe(true)
    expect(isPushService("push.apple.com.evil.test")).toBe(false)
    expect(isPushService("evilpush.apple.com")).toBe(false)
    expect(isPushService("example.com")).toBe(false)
    expect(isPushService("ntfy.example.com", " ntfy.example.com ,*.up.example.org")).toBe(true)
    expect(isPushService("a.up.example.org", "ntfy.example.com,*.up.example.org")).toBe(true)
  })

  it("refuses what isn't a push subscription", async () => {
    const w = await workspace()
    const sub = await browserSubscription()
    const bad = (subscription: unknown) =>
      call("campflare.push.subscribe", { subscription }, w.owner.token, { json: true }).then((r) => r.error)
    expect(await bad({ ...sub, endpoint: "http://push.example/x" })).toBe("invalid_arguments")
    expect(await bad({ ...sub, endpoint: "not a url" })).toBe("invalid_arguments")
    // Only push services: not any https URL.
    expect(await bad({ ...sub, endpoint: "https://internal.campflare.test/admin" })).toBe("invalid_arguments")
    expect(await bad({ endpoint: sub.endpoint })).toBe("invalid_arguments")
    expect(await bad({ ...sub, keys: { ...sub.keys, auth: "AAAA" } })).toBe("invalid_arguments")
    expect(await bad({ ...sub, keys: { ...sub.keys, p256dh: sub.keys.auth } })).toBe("invalid_arguments")
    // 65 bytes shaped like a point, but not on the curve.
    const offCurve = new Uint8Array(65).fill(7)
    offCurve[0] = 4
    const encoded = btoa(String.fromCharCode(...offCurve))
      .replaceAll("+", "-")
      .replaceAll("/", "_")
      .replace(/=+$/, "")
    expect(await bad({ ...sub, keys: { ...sub.keys, p256dh: encoded } })).toBe("invalid_arguments")
    expect(await list(w.owner.token)).toEqual([])
  })

  it("wants push:write to subscribe and push:read to list, from a user token", async () => {
    const w = await workspace()
    const read = await issueToken(env, { teamId: w.teamId, userId: w.owner.id, kind: "user", scopes: ["read"] })
    expect((await call("campflare.push.list", {}, read)).ok).toBe(true)
    const refused = await call("campflare.push.subscribe", { subscription: await browserSubscription() }, read, {
      json: true,
    })
    expect(refused).toMatchObject({ ok: false, error: "missing_scope", needed: "push:write" })
    const app = await w.addApp("Notifier")
    await expectError("campflare.push.list", {}, app.botToken, "not_allowed_token_type")
  })
})

describe("push delivery", () => {
  it("pushes a mention to each of the person's devices, encrypted and signed, saying who, where and what", async () => {
    service = fakePushService()
    const w = await workspace()
    const bob = await w.addUser("bob")
    const phone = await browserSubscription("fcm.example")
    const laptop = await browserSubscription("updates.push.example")
    await subscribe(bob.token, phone, "Phone")
    await subscribe(bob.token, laptop, "Laptop")
    const ts = await post(
      w.owner.token,
      w.general,
      `<@${bob.id}> ¿revisas &lt;esto&gt;? 確認してください <https://campflare.test/x|el informe>`,
    )

    const { hit, payload } = await service.payload(phone)
    expect(payload).toEqual({
      title: "Olive Owner in #general",
      body: "@BOB ¿revisas <esto>? 確認してください el informe",
      tag: w.general,
      route: `#/${w.general}?msg=${ts}`,
      item: expect.any(String),
      type: "mention",
      channel: w.general,
      ts,
    })
    expect(hit.headers.get("content-encoding")).toBe("aes128gcm")
    expect(hit.headers.get("urgency")).toBe("high")
    expect(hit.headers.get("ttl")).toBe("86400")
    expect(hit.headers.get("topic")).toBe(w.general)
    const [, jwt, key] = /^vapid t=([^,]+), k=(.+)$/.exec(hit.headers.get("authorization")!)!
    expect(key).toBe(env.VAPID_PUBLIC_KEY)
    const [header, claims, signature] = jwt!.split(".") as [string, string, string]
    expect(JSON.parse(new TextDecoder().decode(decode(claims)))).toMatchObject({
      aud: "https://fcm.example",
      sub: "mailto:push@campflare.test",
    })
    const verified = await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      await importPublic(decode(key!)!, "ECDSA"),
      decode(signature)!,
      new TextEncoder().encode(`${header}.${claims}`),
    )
    expect(verified).toBe(true)

    expect((await service.payload(laptop)).payload.title).toBe("Olive Owner in #general")
    // last_used says the service took them.
    await eventually(async () => (await list(bob.token)).every((s) => s.last_used > 0))
    // The author's own message pushes nothing to the author.
    expect(await pushesAfterAMoment(service)).toEqual([])
  })

  it("titles DMs, group DMs, replies and reactions, and opens a reply in its thread", async () => {
    service = fakePushService()
    const w = await workspace()
    const bob = await w.addUser("bob")
    const carol = await w.addUser("carol")
    const sub = await browserSubscription()
    await subscribe(bob.token, sub)

    const dm = (await ok<{ channel: { id: string } }>("conversations.open", { users: bob.id }, w.owner.token)).channel
      .id
    await post(w.owner.token, dm, "Grüße aus Berlin")
    expect((await service.payload(sub)).payload).toMatchObject({
      title: "Olive Owner",
      body: "Grüße aus Berlin",
      type: "dm",
    })

    const group = (
      await ok<{ channel: { id: string } }>("conversations.open", { users: `${bob.id},${carol.id}` }, w.owner.token)
    ).channel.id
    await post(w.owner.token, group, "안녕하세요")
    expect((await service.payload(sub)).payload.title).toBe("Olive Owner in a group DM")

    const root = await post(bob.token, w.general, "¿Quién viene?")
    const reply = await post(carol.token, w.general, "moi", { thread_ts: root })
    const replied = await service.payload(sub)
    expect(replied.payload).toMatchObject({
      title: "CAROL replied in #general",
      route: `#/${w.general}/${root}?msg=${reply}`,
    })
    expect(replied.hit.headers.get("urgency")).toBe("normal")
  })

  it("titles a reaction, at normal urgency", async () => {
    service = fakePushService()
    const w = await workspace()
    const bob = await w.addUser("bob")
    const sub = await browserSubscription()
    await subscribe(bob.token, sub)
    const ts = await post(bob.token, w.general, "voilà")
    await ok("reactions.add", { channel: w.general, timestamp: ts, name: "tada" }, w.owner.token)
    const { hit, payload } = await service.payload(sub)
    expect(payload).toMatchObject({ title: "Olive Owner reacted :tada: in #general", body: "voilà", type: "reaction" })
    expect(hit.headers.get("urgency")).toBe("normal")
  })

  it("pushes nothing for items that don't notify: a muted conversation, a snooze", async () => {
    service = fakePushService()
    const w = await workspace()
    const bob = await w.addUser("bob")
    await subscribe(bob.token, await browserSubscription())
    await ok("campflare.prefs.set", { channel: w.general, level: "none" }, bob.token)
    await post(w.owner.token, w.general, `<@${bob.id}> silencio`)
    await ok("campflare.prefs.set", { channel: w.general, level: "default" }, bob.token)
    await ok("dnd.setSnooze", { num_minutes: 30 }, bob.token)
    await post(w.owner.token, w.general, `<@${bob.id}> 静かに`)
    expect(await pushesAfterAMoment(service)).toEqual([])
    const items = (await ok<{ items: { notify: boolean }[] }>("campflare.activity.list", {}, bob.token)).items
    expect(items.map((i) => i.notify)).toEqual([false, false])
  })

  it("doesn't push to someone looking at the app: an RTM link said it's active", async () => {
    service = fakePushService()
    const w = await workspace()
    const bob = await w.addUser("bob")
    const sub = await browserSubscription()
    await subscribe(bob.token, sub)
    const link = await connect((await ok<{ url: string }>("rtm.connect", {}, bob.token)).url)
    await link.next((f) => f.type === "hello")
    link.ws.send(JSON.stringify({ type: "campflare.active", active: true }))
    await settle()
    await post(w.owner.token, w.general, `<@${bob.id}> aquí`)
    await link.next((f) => f.type === "activity_added")
    expect(await pushesAfterAMoment(service)).toEqual([])

    link.ws.send(JSON.stringify({ type: "campflare.active", active: false }))
    await settle()
    await post(w.owner.token, w.general, `<@${bob.id}> où es-tu ?`)
    expect((await service.payload(sub)).payload.body).toBe("@BOB où es-tu ?")
    link.close()
  })

  it(`stops at ${PUSH_PER_MINUTE} pushes per person per minute`, async () => {
    service = fakePushService()
    const w = await workspace()
    const bob = await w.addUser("bob")
    await subscribe(bob.token, await browserSubscription())
    await runInDurableObject(hubOf(w.teamId), async (_hub: TeamHub, state) => {
      state.storage.sql.exec(
        "INSERT INTO push_counts (user_id, minute, count) VALUES (?, ?, ?)",
        bob.id,
        Math.floor(Date.now() / 60_000),
        PUSH_PER_MINUTE,
      )
    })
    await post(w.owner.token, w.general, `<@${bob.id}> one too many`)
    expect(await pushesAfterAMoment(service)).toEqual([])
  })

  it("forgets a subscription the push service says is gone (410)", async () => {
    service = fakePushService()
    service.answer = () => new Response(null, { status: 410 })
    const w = await workspace()
    const bob = await w.addUser("bob")
    const sub = await browserSubscription()
    await subscribe(bob.token, sub)
    await post(w.owner.token, w.general, `<@${bob.id}> ¿sigues ahí?`)
    await service.next()
    await eventually(async () => (await list(bob.token)).length === 0)
    // And the hub forgot it too: the next mention pushes nothing.
    await post(w.owner.token, w.general, `<@${bob.id}> 还在吗`)
    expect(await pushesAfterAMoment(service)).toEqual([])
  })

  it("retries a push the service couldn't take (429, 5xx) from the hub's alarm, then gives up", async () => {
    service = fakePushService()
    service.answer = () => new Response(null, { status: 503 })
    const w = await workspace()
    const bob = await w.addUser("bob")
    const sub = await browserSubscription()
    await subscribe(bob.token, sub)
    const before = Date.now()
    await post(w.owner.token, w.general, `<@${bob.id}> reintento`)
    await service.next()
    const [pending] = await eventually(async () => {
      const rows = await pendingRetries(w.teamId)
      return rows.length ? rows : undefined
    })
    expect(pending!.attempts).toBe(1)
    expect(pending!.due).toBeGreaterThanOrEqual(before + PUSH_RETRY_DELAYS_MS[0]!)

    // Retry-After wins over the schedule.
    service.answer = () => new Response(null, { status: 429, headers: { "retry-after": "120" } })
    await retryNow(w.teamId)
    expect((await service.payload(sub)).payload.body).toBe("@BOB reintento")
    const [later] = await pendingRetries(w.teamId)
    expect(later!.attempts).toBe(2)
    expect(later!.due).toBeGreaterThanOrEqual(Date.now() + 110_000)

    await retryNow(w.teamId)
    await service.next()
    expect(await pendingRetries(w.teamId)).toHaveLength(1)
    await retryNow(w.teamId)
    await service.next()
    // Out of retries.
    expect(await pendingRetries(w.teamId)).toEqual([])
  })

  it("cancels a pending retry when its subscription is removed, and skips it while the person is looking", async () => {
    service = fakePushService()
    service.answer = () => new Response(null, { status: 503 })
    const w = await workspace()
    const bob = await w.addUser("bob")
    const sub = await browserSubscription()
    const { subscription } = await subscribe(bob.token, sub)
    await post(w.owner.token, w.general, `<@${bob.id}> bientôt`)
    await service.next()
    await eventually(async () => (await pendingRetries(w.teamId)).length === 1)
    await ok("campflare.push.unsubscribe", { id: subscription.id }, bob.token)
    expect(await pendingRetries(w.teamId)).toEqual([])

    // Subscribed again, a retry is dropped while bob has the app in front of him.
    await subscribe(bob.token, sub)
    await post(w.owner.token, w.general, `<@${bob.id}> 곧`)
    await service.next()
    await eventually(async () => (await pendingRetries(w.teamId)).length === 1)
    const link = await connect((await ok<{ url: string }>("rtm.connect", {}, bob.token)).url)
    await link.next((f) => f.type === "hello")
    link.ws.send(JSON.stringify({ type: "campflare.active", active: true }))
    await settle()
    service.answer = () => new Response(null, { status: 201 })
    await retryNow(w.teamId)
    expect(await pushesAfterAMoment(service)).toEqual([])
    expect(await pendingRetries(w.teamId)).toEqual([])
    link.close()
  })

  it("counts a retry towards the cap", async () => {
    service = fakePushService()
    service.answer = () => new Response(null, { status: 503 })
    const w = await workspace()
    const bob = await w.addUser("bob")
    await subscribe(bob.token, await browserSubscription())
    await post(w.owner.token, w.general, `<@${bob.id}> límite`)
    await service.next()
    await eventually(async () => (await pendingRetries(w.teamId)).length === 1)
    await runInDurableObject(hubOf(w.teamId), async (_hub: TeamHub, state) => {
      state.storage.sql.exec("UPDATE push_counts SET count = ? WHERE user_id = ?", PUSH_PER_MINUTE, bob.id)
    })
    await retryNow(w.teamId)
    expect(await pushesAfterAMoment(service)).toEqual([])
    expect(await pendingRetries(w.teamId)).toEqual([])
  })

  it("delivers a retry that then succeeds, and drops one whose subscription went", async () => {
    service = fakePushService()
    service.answer = () => new Response(null, { status: 500 })
    const w = await workspace()
    const bob = await w.addUser("bob")
    const sub = await browserSubscription()
    await subscribe(bob.token, sub)
    await post(w.owner.token, w.general, `<@${bob.id}> encore`)
    await service.next()
    await eventually(async () => (await pendingRetries(w.teamId)).length === 1)
    service.answer = () => new Response(null, { status: 201 })
    await retryNow(w.teamId)
    expect((await service.payload(sub)).payload.body).toBe("@BOB encore")
    expect(await pendingRetries(w.teamId)).toEqual([])
    await eventually(async () => (await list(bob.token))[0]!.last_used > 0)

    // A network failure is retried too; then the device goes away (410) on the retry.
    service.answer = () => Promise.reject(new TypeError("network down"))
    await post(w.owner.token, w.general, `<@${bob.id}> une dernière fois`)
    await service.next()
    await eventually(async () => (await pendingRetries(w.teamId)).length === 1)
    service.answer = () => new Response(null, { status: 404 })
    await retryNow(w.teamId)
    await service.next()
    await eventually(async () => (await list(bob.token)).length === 0)
    expect(await pendingRetries(w.teamId)).toEqual([])
  })

  it("drops what a push service refuses outright (400) without retrying", async () => {
    service = fakePushService()
    service.answer = () => new Response("bad", { status: 400 })
    const w = await workspace()
    const bob = await w.addUser("bob")
    await subscribe(bob.token, await browserSubscription())
    await post(w.owner.token, w.general, `<@${bob.id}> mal`)
    await service.next()
    await settle()
    expect(await pendingRetries(w.teamId)).toEqual([])
    expect(await list(bob.token)).toHaveLength(1)
  })
})

describe("campflare.push.test", () => {
  it("sends a test to each device now, forgetting gone ones, and says how it went", async () => {
    service = fakePushService()
    const w = await workspace()
    const working = await browserSubscription("fcm.example")
    const gone = await browserSubscription("gone.example")
    const down = await browserSubscription("down.example")
    service.answer = (hit) =>
      new Response(null, { status: hit.endpoint.includes("gone") ? 410 : hit.endpoint.includes("down") ? 502 : 201 })
    const { subscription } = await subscribe(w.owner.token, working, "Pixel")
    await subscribe(w.owner.token, gone, "Old phone")
    await subscribe(w.owner.token, down, "Tablet")
    const res = await ok<{ sent: number; failed: number; removed: number; results: unknown[] }>(
      "campflare.push.test",
      {},
      w.owner.token,
    )
    expect(res).toMatchObject({ sent: 1, failed: 1, removed: 1 })
    expect(res.results).toContainEqual({ id: subscription.id, result: "delivered" })
    expect(res.results.map((r) => (r as { result: string }).result).toSorted()).toEqual(["delivered", "failed", "gone"])
    expect(JSON.stringify(res)).not.toContain("502")
    expect((await service.payload(working)).payload).toMatchObject({
      title: "Campflare",
      body: "Notifications work on Pixel.",
      route: "#/",
    })
    expect((await list(w.owner.token)).map((s) => s.label).toSorted()).toEqual(["Pixel", "Tablet"])

    // One device by id.
    expect(await ok("campflare.push.test", { id: subscription.id }, w.owner.token)).toMatchObject({ sent: 1 })
    await expectError("campflare.push.test", { id: "PNOPE" }, w.owner.token, "subscription_not_found")
  })
})
