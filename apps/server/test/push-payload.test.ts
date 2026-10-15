import { afterEach, describe, expect, it } from "vitest"
import { BODY_LIMIT, itemPush, plainText, routeOf, type Names } from "../src/push/payload"
import { PUSH_TIMEOUT_MS, sendPush, setPushFetch, vapidOf } from "../src/push/send"
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
  it("is off without keys, and takes keys in Web Push's encoding", async () => {
    expect(vapidOf({}, "https://campflare.test")).toBeUndefined()
    const pair = await generateKeyPair()
    expect(vapidOf({ VAPID_PUBLIC_KEY: pair.publicKey, VAPID_PRIVATE_KEY: pair.privateKey }, "https://a.test")).toEqual(
      {
        ...parseKeyPair(pair),
        subject: "https://a.test",
      },
    )
  })

  it("treats keys it can't use as gone, a timeout as transient, and reads Retry-After as a date", async () => {
    const pair = await generateKeyPair()
    const vapid = { ...parseKeyPair(pair)!, subject: "mailto:push@campflare.test" }
    const sub = await browserSubscription()
    const target = { endpoint: sub.endpoint, ...sub.keys }
    const message = { payload: { title: "x" }, urgency: "normal" as const }
    expect(await sendPush(vapid, { ...target, p256dh: "%%%" }, message)).toMatchObject({ gone: true, transient: false })
    // A point that isn't on the curve: WebCrypto refuses it.
    const offCurve = btoa(String.fromCharCode(4, ...Array.from({ length: 64 }, () => 7)))
    expect(await sendPush(vapid, { ...target, p256dh: offCurve }, message)).toMatchObject({ gone: true })

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
