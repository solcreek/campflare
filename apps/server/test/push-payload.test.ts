import { env } from "cloudflare:workers"
import { afterEach, describe, expect, it, vi } from "vitest"
import { BODY_LIMIT, itemPush, plainText, routeOf, type Names } from "../src/push/payload"
import { fitPayload, PUSH_TIMEOUT_MS, sendPush, setPushFetch } from "../src/push/send"
import { MAX_PLAINTEXT } from "../src/push/encrypt"
import { loadVapid } from "../src/push/vapid"
import { generateKeyPair, parseKeyPair } from "../src/push/keys"
import { isActiveLink, ACTIVE_WINDOW_MS } from "../src/push/deliver"
import { browserSubscription } from "./push-service"

const names: Names = {
  users: new Map([
    ["U1", "Zoë"],
    ["U2", "李雷"],
  ]),
  conversations: new Map([
    ["C1", { name: "général", kind: "channel" }],
    ["D1", { name: "", kind: "im" }],
  ]),
}

afterEach(() => setPushFetch(undefined))

describe("plainText", () => {
  it("turns mrkdwn into what a lock screen shows", () => {
    expect(plainText("<@U2> y <@U9> y <@U1|zoe>", names)).toBe("@李雷 y @someone y @zoe")
    expect(plainText("<#C1> <#C2|random> <#C3>", names)).toBe("#général #random #channel")
    expect(plainText("<!here> <!channel|channel> <!subteam^S1|@diseño> <!subteam^S2>", names)).toBe(
      "@here @channel @diseño @group",
    )
    expect(plainText("<https://campflare.test> <mailto:hi@campflare.test|correo> <mailto:a@b.test>", names)).toBe(
      "https://campflare.test correo a@b.test",
    )
    expect(plainText("a &lt;b&gt; &amp;\n\n  c", names)).toBe("a <b> & c")
  })
})

describe("itemPush", () => {
  it("falls back for what it can't name, and truncates long bodies by character", () => {
    const long = "한".repeat(BODY_LIMIT + 10)
    const push = itemPush(
      { id: "1", type: "mention", channel: "C9", ts: "1.000001", message: { text: long, username: "Deploy bot" } },
      names,
    )
    expect(push.payload.title).toBe("Deploy bot")
    expect([...push.payload.body]).toHaveLength(BODY_LIMIT)
    expect(push.payload.body.endsWith("…")).toBe(true)
    expect(push.urgency).toBe("high")
    expect(push.topic).toBe("C9")

    expect(
      itemPush({ id: "2", type: "dm", channel: "D1", ts: "2", actor: "U8", message: {} }, names).payload,
    ).toMatchObject({
      title: "Someone",
      body: "sent a message",
    })
    expect(
      itemPush({ id: "3", type: "dm", channel: "D1", ts: "3", actor: "U1", message: { text: "", files: [{}] } }, names)
        .payload.body,
    ).toBe("sent a file")
    expect(itemPush({ id: "4", type: "reaction", channel: "C1", ts: "4" }, names).payload.title).toBe(
      "Campflare reacted :: in #général",
    )
  })

  it("routes to the message, in its thread for a reply", () => {
    expect(routeOf({ channel: "C1", ts: "2.000000" })).toBe("#/C1?msg=2.000000")
    expect(routeOf({ channel: "C1", ts: "2.000000", thread_ts: "1.000000" })).toBe("#/C1/1.000000?msg=2.000000")
  })
})

describe("sendPush", () => {
  it("is off without keys, or with a pair that doesn't match, and takes keys in Web Push's encoding", async () => {
    expect(await loadVapid({}, "https://campflare.test")).toBeUndefined()
    const pair = await generateKeyPair()
    const other = await generateKeyPair()
    const vapid = await loadVapid(
      { VAPID_PUBLIC_KEY: pair.publicKey, VAPID_PRIVATE_KEY: pair.privateKey },
      "https://a.test",
    )
    expect(vapid).toMatchObject({ publicKey: parseKeyPair(pair)!.publicKey, subject: "https://a.test" })
    // Checked once: the same pair again is the same keys.
    const again = await loadVapid(
      { VAPID_PUBLIC_KEY: pair.publicKey, VAPID_PRIVATE_KEY: pair.privateKey, VAPID_SUBJECT: "mailto:a@b.test" },
      "https://a.test",
    )
    expect(again!.signingKey).toBe(vapid!.signingKey)
    expect(again!.subject).toBe("mailto:a@b.test")
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined)
    expect(
      await loadVapid({ VAPID_PUBLIC_KEY: pair.publicKey, VAPID_PRIVATE_KEY: other.privateKey }, "https://a.test"),
    ).toBeUndefined()
    expect(
      await loadVapid({ VAPID_PUBLIC_KEY: pair.publicKey, VAPID_PRIVATE_KEY: "short" }, "https://a.test"),
    ).toBeUndefined()
    expect(errors).toHaveBeenCalledTimes(2)
    errors.mockRestore()
  })

  it("never blames the subscription for the server's own key", async () => {
    const sub = await browserSubscription()
    const target = { endpoint: sub.endpoint, ...sub.keys }
    // A key that can't sign (an ECDH key): signing the JWT fails.
    const wrong = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, false, [
      "deriveBits",
    ])) as CryptoKeyPair
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined)
    const outcome = await sendPush(
      { publicKey: new Uint8Array(65), signingKey: wrong.privateKey, subject: "mailto:x@y.test" },
      target,
      { payload: {}, urgency: "high" },
    )
    errors.mockRestore()
    expect(outcome).toMatchObject({ ok: false, gone: false, transient: false, misconfigured: true })
  })

  it("cuts a body that won't fit one push, and refuses for good what can't be cut", async () => {
    const long = { title: "t", body: "长".repeat(MAX_PLAINTEXT) }
    const fitted = new TextDecoder().decode(fitPayload(long))
    expect(fitted.length).toBeLessThanOrEqual(MAX_PLAINTEXT)
    expect((JSON.parse(fitted) as { body: string }).body.endsWith("…")).toBe(true)
    expect(fitPayload({ title: "x".repeat(MAX_PLAINTEXT) })).toBeUndefined()
    expect(fitPayload({ title: "x".repeat(MAX_PLAINTEXT), body: "y" })).toBeUndefined()
    const vapid = await loadVapid(
      { VAPID_PUBLIC_KEY: env.VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY: env.VAPID_PRIVATE_KEY },
      "https://a.test",
    )
    const sub = await browserSubscription()
    let posted = 0
    setPushFetch(async () => {
      posted++
      return new Response(null, { status: 201 })
    })
    const target = { endpoint: sub.endpoint, ...sub.keys }
    expect(await sendPush(vapid!, target, { payload: long, urgency: "high" })).toMatchObject({ ok: true })
    expect(await sendPush(vapid!, target, { payload: { title: "x".repeat(MAX_PLAINTEXT) }, urgency: "high" })).toEqual({
      ok: false,
      status: 0,
      gone: false,
      transient: false,
    })
    expect(posted).toBe(1)
  })

  it("treats keys it can't use as gone, a timeout as transient, and reads Retry-After as a date", async () => {
    const pair = await generateKeyPair()
    const vapid = (await loadVapid(
      { VAPID_PUBLIC_KEY: pair.publicKey, VAPID_PRIVATE_KEY: pair.privateKey },
      "mailto:push@campflare.test",
    ))!
    const sub = await browserSubscription()
    const target = { endpoint: sub.endpoint, ...sub.keys }
    const message = { payload: { title: "x" }, urgency: "normal" as const }
    expect(await sendPush(vapid, { ...target, p256dh: "%%%" }, message)).toMatchObject({ gone: true, transient: false })
    // A point that isn't on the curve: WebCrypto refuses it.
    const offCurve = btoa(String.fromCharCode(4, ...Array.from({ length: 64 }, () => 7)))
    expect(await sendPush(vapid, { ...target, p256dh: offCurve }, message)).toMatchObject({ gone: true })

    expect(await sendPush(vapid, { ...target, auth: "AAAA" }, message)).toMatchObject({ gone: true })
    setPushFetch(() => Promise.reject(new DOMException("timed out", "TimeoutError")))
    expect(await sendPush(vapid, target, message)).toMatchObject({ ok: false, status: 0, transient: true })
    expect(PUSH_TIMEOUT_MS).toBeGreaterThan(0)

    const at = new Date(Date.now() + 60_000).toUTCString()
    setPushFetch(async () => new Response(null, { status: 503, headers: { "retry-after": at } }))
    const outcome = await sendPush(vapid, target, message)
    expect(outcome.retryAfterMs).toBeGreaterThan(50_000)
    setPushFetch(async () => new Response(null, { status: 503, headers: { "retry-after": "soon" } }))
    expect((await sendPush(vapid, target, message)).retryAfterMs).toBeUndefined()
  })
})

describe("isActiveLink", () => {
  it("counts an RTM link that said it's active within the window", () => {
    const now = 1_000_000_000
    expect(isActiveLink({ kind: "rtm", activeAt: now - 1000 }, now)).toBe(true)
    expect(isActiveLink({ kind: "rtm", activeAt: now - ACTIVE_WINDOW_MS - 1 }, now)).toBe(false)
    expect(isActiveLink({ kind: "rtm", activeAt: 0 }, now)).toBe(false)
    expect(isActiveLink({ kind: "rtm" }, now)).toBe(false)
    expect(isActiveLink({ kind: "socket", activeAt: now }, now)).toBe(false)
    expect(isActiveLink(null, now)).toBe(false)
  })
})
