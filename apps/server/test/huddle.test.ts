import { env } from "cloudflare:workers"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { Args } from "../src/api/args"
import { methods, type Actor, type Ctx } from "../src/api/context"
import { setSfuFetch } from "../src/huddle/methods"
import { createSfu, iceServers, SfuError } from "../src/huddle/sfu"
import { fakeSfu, type FakeSfu } from "./fake-sfu"
import exchanges from "./fixtures/sfu/exchanges.json"
import { call, connect, expectError, ok, workspace, type Workspace } from "./helpers"

// The huddle API offline, against a fake SFU built from recorded responses.

type Recorded = { operation: string; request?: { sessionDescription?: { sdp: string } } }
const recorded = exchanges as Recorded[]
const OFFER = recorded.find((e) => e.operation === "POST /sessions/{id}/tracks/new" && e.request?.sessionDescription)!
  .request!.sessionDescription!.sdp
const ANSWER = recorded.find(
  (e) =>
    e.operation === "PUT /sessions/{id}/renegotiate" &&
    e.request?.sessionDescription?.sdp.startsWith("v=0") &&
    e.request.sessionDescription.sdp.length > 10,
)!.request!.sessionDescription!.sdp

type Joined = {
  session_id: string
  sdp: string
  participants: { user: string; session_id: string; track_name: string }[]
}
type Subscribed = { session_id: string; sdp: string; tracks: { mid: string; session_id: string; track_name: string }[] }

let sfu: FakeSfu
beforeEach(() => {
  sfu = fakeSfu()
  setSfuFetch(sfu.fetch)
})
afterEach(() => setSfuFetch(undefined))

const join = (w: Workspace | { token: string }, channel: string, extra: Record<string, unknown> = {}) =>
  ok<Joined>(
    "campflare.huddles.join",
    { channel, sdp: OFFER, mid: "0", ...extra },
    "token" in w ? w.token : w.owner.token,
  )

describe("campflare.huddles", () => {
  it("joins a call: publishes through the SFU and returns its answer", async () => {
    const w = await workspace()
    const res = await join(w, w.general)
    expect(res.session_id).toMatch(/^fake-session-/)
    expect(res.sdp).toMatch(/^v=0/)
    expect(res.participants).toEqual([])
    expect(sfu.calls.map((c) => `${c.method} ${c.path.replace(/fake-session-\d+/, "{id}")}`)).toEqual([
      "POST /sessions/new",
      "POST /sessions/{id}/tracks/new",
    ])
    expect(sfu.calls[1]!.body).toMatchObject({
      sessionDescription: { type: "offer", sdp: OFFER },
      tracks: [{ location: "local", mid: "0", trackName: "audio" }],
    })
    expect(await ok("campflare.huddles.info", { channel: w.general }, w.owner.token)).toMatchObject({
      participants: [{ user: w.owner.id, session_id: res.session_id, track_name: "audio" }],
    })
  })

  it("tells members who joined and who left, over RTM", async () => {
    const w = await workspace()
    const bob = await w.addUser("bob")
    const link = await connect((await ok<{ url: string }>("rtm.connect", {}, bob.token)).url)
    await link.next((f) => f.type === "hello")
    const joined = await join(w, w.general)
    expect(await link.next((f) => f.type === "huddle_joined")).toMatchObject({
      channel: w.general,
      user: w.owner.id,
      session_id: joined.session_id,
      track_name: "audio",
    })
    expect(await ok("campflare.huddles.leave", { channel: w.general }, w.owner.token)).toEqual({ ok: true, left: true })
    expect(await link.next((f) => f.type === "huddle_left")).toMatchObject({
      user: w.owner.id,
      session_id: joined.session_id,
    })
    expect(await ok("campflare.huddles.leave", { channel: w.general }, w.owner.token)).toEqual({
      ok: true,
      left: false,
    })
    // Leaving stops forwarding the publication, without negotiation.
    expect(sfu.calls.at(-1)).toMatchObject({ method: "PUT", body: { tracks: [{ mid: "0" }], force: true } })
    link.close()
  })

  it("subscribes to others in the call, then takes the browser's answer", async () => {
    const w = await workspace()
    const bob = await w.addUser("bob")
    const alice = await join(w, w.general)
    const bobs = await join(bob, w.general)
    expect(bobs.participants).toEqual([expect.objectContaining({ user: w.owner.id, session_id: alice.session_id })])

    const sub = await ok<Subscribed>(
      "campflare.huddles.subscribe",
      { channel: w.general, publications: [{ session_id: alice.session_id, track_name: "audio" }] },
      bob.token,
    )
    expect(sub.sdp).toMatch(/^v=0/)
    expect(sub.tracks).toEqual([{ mid: "0", session_id: alice.session_id, track_name: "audio" }])
    await ok("campflare.huddles.answer", { session_id: sub.session_id, sdp: ANSWER }, bob.token)
    expect(sfu.calls.at(-1)).toMatchObject({
      method: "PUT",
      body: { sessionDescription: { type: "answer", sdp: ANSWER } },
    })

    // More publications go into the same receiving session.
    const carol = await w.addUser("carol")
    const carols = await join(carol, w.general)
    const more = await ok<Subscribed>(
      "campflare.huddles.subscribe",
      {
        channel: w.general,
        session_id: sub.session_id,
        publications: [{ session_id: carols.session_id, track_name: "audio" }],
      },
      bob.token,
    )
    expect(more.session_id).toBe(sub.session_id)
  })

  it("only lets members in, and only to what's in this call", async () => {
    const w = await workspace()
    const bob = await w.addUser("bob")
    const {
      channel: { id: channel },
    } = await ok<{ channel: { id: string } }>("conversations.create", { name: "x", is_private: true }, w.owner.token)
    await expectError("campflare.huddles.join", { channel, sdp: OFFER, mid: "0" }, bob.token, "channel_not_found")
    await expectError("campflare.huddles.info", { channel }, bob.token, "channel_not_found")
    const alice = await join(w, channel)
    const own = { channel, publications: [{ session_id: alice.session_id, track_name: "audio" }] }
    await expectError("campflare.huddles.subscribe", own, w.owner.token, "huddle_publication_not_found") // not your own
    await expectError(
      "campflare.huddles.subscribe",
      { ...own, channel: w.general },
      bob.token,
      "huddle_publication_not_found",
    )
    await expectError("campflare.huddles.subscribe", { channel: w.general }, bob.token, "invalid_arguments")
  })

  it("keeps sessions to their owners", async () => {
    const w = await workspace()
    const bob = await w.addUser("bob")
    const carol = await w.addUser("carol")
    const alice = await join(w, w.general)
    const sub = await ok<Subscribed>(
      "campflare.huddles.subscribe",
      { channel: w.general, publications: [{ session_id: alice.session_id, track_name: "audio" }] },
      bob.token,
    )
    // Carol can't answer for Bob's session, nor add to it; nobody answers on a publishing session.
    await expectError(
      "campflare.huddles.answer",
      { session_id: sub.session_id, sdp: ANSWER },
      carol.token,
      "huddle_session_not_found",
    )
    await expectError(
      "campflare.huddles.subscribe",
      {
        channel: w.general,
        session_id: sub.session_id,
        publications: [{ session_id: alice.session_id, track_name: "audio" }],
      },
      carol.token,
      "huddle_session_not_found",
    )
    await expectError(
      "campflare.huddles.answer",
      { session_id: alice.session_id, sdp: ANSWER },
      w.owner.token,
      "huddle_session_not_found",
    )
  })

  it("validates SDP", async () => {
    const w = await workspace()
    await expectError(
      "campflare.huddles.join",
      { channel: w.general, sdp: "nope", mid: "0" },
      w.owner.token,
      "invalid_arguments",
    )
    await expectError("campflare.huddles.join", { channel: w.general, sdp: OFFER }, w.owner.token, "invalid_arguments")
  })

  it("replaces an earlier seat on rejoin, stopping its forwarding", async () => {
    const w = await workspace()
    const first = await join(w, w.general)
    const second = await join(w, w.general)
    expect(second.session_id).not.toBe(first.session_id)
    const info = await ok<{ participants: unknown[] }>("campflare.huddles.info", { channel: w.general }, w.owner.token)
    expect(info.participants).toHaveLength(1)
    for (let i = 0; i < 20 && !sfu.calls.some((c) => c.path.includes(`${first.session_id}/tracks/close`)); i++) {
      await new Promise((r) => setTimeout(r, 10))
    }
    expect(sfu.calls.some((c) => c.path.includes(`${first.session_id}/tracks/close`))).toBe(true)
  })

  it("reports SFU failures as huddle_media_error, as the real API words them", async () => {
    const w = await workspace()
    const bob = await w.addUser("bob")
    sfu.failNext("POST /sessions/new", 500, "internal_error")
    expect(
      await call("campflare.huddles.join", { channel: w.general, sdp: OFFER, mid: "0" }, w.owner.token),
    ).toMatchObject({
      ok: false,
      error: "huddle_media_error",
      detail: "internal_error",
    })
    const alice = await join(w, w.general)
    // The recorded per-track error: subscribing to a track the SFU doesn't have.
    sfu.published.clear()
    expect(
      await call(
        "campflare.huddles.subscribe",
        { channel: w.general, publications: [{ session_id: alice.session_id, track_name: "audio" }] },
        bob.token,
      ),
    ).toMatchObject({ error: "huddle_media_error", detail: "not_found_track_error" })
    // The recorded 425 for a session the SFU no longer knows.
    sfu.published.set(`${alice.session_id}/audio`, "0")
    const sub = await ok<Subscribed>(
      "campflare.huddles.subscribe",
      { channel: w.general, publications: [{ session_id: alice.session_id, track_name: "audio" }] },
      bob.token,
    )
    sfu.sessions.delete(sub.session_id)
    expect(
      await call("campflare.huddles.answer", { session_id: sub.session_id, sdp: ANSWER }, bob.token),
    ).toMatchObject({
      error: "huddle_media_error",
      detail: "session_error",
    })
  })

  it("hands out STUN by default", async () => {
    const w = await workspace()
    expect(await ok("campflare.huddles.ice_servers", {}, w.owner.token)).toMatchObject({
      ice_servers: [{ urls: ["stun:stun.cloudflare.com:3478"] }],
    })
  })

  it("needs the SFU configured", async () => {
    const w = await workspace()
    const actor = { kind: "user", team: { id: w.teamId }, user: { id: w.owner.id }, scopes: [] } as unknown as Actor
    const ctx = {
      env: { ...env, REALTIME_APP_ID: "", REALTIME_APP_SECRET: "" },
      args: new Args({ channel: w.general, sdp: OFFER, mid: "0" }),
      auth: actor,
      request: new Request("https://campflare.test/"),
      origin: "https://campflare.test",
      waitUntil: () => undefined,
    }
    await expect(methods.get("campflare.huddles.join")!.handler(ctx as Ctx<Actor | undefined>)).rejects.toThrow(
      "huddles_not_configured",
    )
  })
})

/** An SFU client whose every call gets this answer. */
const sfuReplying = (body: unknown, status = 200) =>
  createSfu({
    appId: "a",
    appSecret: "s",
    fetch: (async () =>
      new Response(typeof body === "string" ? body : JSON.stringify(body), { status })) as typeof fetch,
  })

describe("SFU client details", () => {
  it("adds short-lived TURN servers when a TURN key is set, minus port 53", async () => {
    const turn = (async () =>
      Response.json({
        iceServers: [
          { urls: ["stun:stun.cloudflare.com:3478"] },
          {
            urls: ["turn:turn.cloudflare.com:3478?transport=udp", "turn:turn.cloudflare.com:53?transport=udp"],
            username: "u",
            credential: "c",
          },
        ],
      })) as typeof fetch
    const servers = await iceServers({ REALTIME_TURN_KEY_ID: "k", REALTIME_TURN_KEY_TOKEN: "t" }, turn)
    expect(servers[1]).toEqual({
      urls: ["turn:turn.cloudflare.com:3478?transport=udp"],
      username: "u",
      credential: "c",
    })
    const down = (async () => new Response("", { status: 500 })) as typeof fetch
    expect(await iceServers({ REALTIME_TURN_KEY_ID: "k", REALTIME_TURN_KEY_TOKEN: "t" }, down)).toEqual([
      { urls: ["stun:stun.cloudflare.com:3478"] },
    ])
    const single = (async () =>
      Response.json({ iceServers: [{ urls: "stun:stun.cloudflare.com:3478" }] })) as typeof fetch
    expect(await iceServers({ REALTIME_TURN_KEY_ID: "k", REALTIME_TURN_KEY_TOKEN: "t" }, single)).toEqual([
      { urls: ["stun:stun.cloudflare.com:3478"] },
    ])
  })

  it("raises SfuError for HTTP failures, unreadable bodies and per-track errors", async () => {
    await expect(sfuReplying("oops", 502).newSession()).rejects.toMatchObject({ status: 502, code: "http_502" })
    await expect(
      sfuReplying({ errorCode: "invalid_request" }, 400).renegotiate("x", { type: "answer", sdp: "v=0" }),
    ).rejects.toBeInstanceOf(SfuError)
    await expect(
      sfuReplying({ tracks: [{ errorCode: "not_found_track_error" }] }).subscribe("x", [
        { sessionId: "y", trackName: "t" },
      ]),
    ).rejects.toMatchObject({
      code: "not_found_track_error",
    })
    await expect(sfuReplying({}).forceClose("x", [])).resolves.toBeUndefined()
  })
})

describe("the /huddle page", () => {
  it("serves the page and its script, scripts from this origin only", async () => {
    const { SELF } = await import("cloudflare:test")
    const page = await SELF.fetch("https://campflare.test/huddle")
    expect(page.headers.get("content-type")).toContain("text/html")
    expect(await page.text()).toContain('<script src="/huddle.js" type="module"></script>')
    expect(page.headers.get("content-security-policy")).toContain("script-src 'self'")
    const script = await SELF.fetch("https://campflare.test/huddle.js")
    expect(script.headers.get("content-type")).toContain("text/javascript")
    expect(await script.text()).toContain("campflare.huddles.join")
  })
})
