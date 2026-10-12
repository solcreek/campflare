import { env } from "cloudflare:workers"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { Args } from "../src/api/args"
import { methods, type Actor, type Ctx } from "../src/api/context"
import { setSfuFetch } from "../src/huddle/methods"
import { createSfu, iceServers, SfuError } from "../src/huddle/sfu"
import { fakeSfu, type FakeSfu } from "./fake-sfu"
import exchanges from "./fixtures/sfu/exchanges.json"
import videoExchanges from "./fixtures/sfu/exchanges-video.json"
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
  participants: { user: string; session_id: string; tracks: { name: string; kind: string; rids?: string[] }[] }[]
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
      participants: [{ user: w.owner.id, session_id: res.session_id, tracks: [{ name: "audio", kind: "audio" }] }],
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
      tracks: [{ name: "audio", kind: "audio" }],
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

  it("switches a subscription's simulcast layer in place, raising the real per-track error", async () => {
    const seen: unknown[] = []
    const recordingSfu = createSfu({
      appId: "a",
      appSecret: "s",
      fetch: (async (_url: RequestInfo | URL, init?: RequestInit) => {
        seen.push(JSON.parse(String(init?.body)))
        return Response.json({ requiresImmediateRenegotiation: false, tracks: [{ mid: "1" }] })
      }) as typeof fetch,
    })
    await recordingSfu.update("recv", [
      { mid: "1", sessionId: "pub", trackName: "camera", simulcast: { preferredRid: "q" } },
    ])
    expect(seen[0]).toEqual({
      tracks: [
        { location: "remote", mid: "1", sessionId: "pub", trackName: "camera", simulcast: { preferredRid: "q" } },
      ],
    })
    // Recorded from the real SFU: updating a subscription that doesn't exist.
    const missing = (videoExchanges as { operation: string; response: { tracks?: { errorCode?: string }[] } }[]).find(
      (e) => e.operation === "PUT /sessions/{id}/tracks/update" && e.response.tracks?.some((t) => t.errorCode),
    )!
    await expect(
      sfuReplying(missing.response).update("recv", [{ mid: "99", sessionId: "pub", trackName: "camera" }]),
    ).rejects.toMatchObject({
      code: "internal_error",
    })
  })

  it("streams publications to WebSocket endpoints as PCM, and closes the adapters", async () => {
    const fake = fakeSfu()
    const client = createSfu({ appId: "a", appSecret: "s", fetch: fake.fetch })
    fake.published.set("pub/audio", "0")
    const created = await client.streamToWebSocket([
      { sessionId: "pub", trackName: "audio", endpoint: "wss://x.test/a" },
      { sessionId: "pub", trackName: "nope", endpoint: "wss://x.test/b" },
    ])
    expect(fake.calls[0]!.body).toEqual({
      tracks: [
        { location: "remote", outputCodec: "pcm", sessionId: "pub", trackName: "audio", endpoint: "wss://x.test/a" },
        { location: "remote", outputCodec: "pcm", sessionId: "pub", trackName: "nope", endpoint: "wss://x.test/b" },
      ],
    })
    // A partial batch: one adapter made, one entry failed on its own.
    expect(created[0]).toMatchObject({ trackName: "audio", adapterId: expect.any(String) })
    expect(created[1]).toMatchObject({ trackName: "nope", errorCode: "websocket_handshake_failed" })
    await client.closeAdapters([created[0]!.adapterId!])
    expect(fake.adapters.get(created[0]!.adapterId!)?.closed).toBe(true)
    expect(await client.closeAdapters([])).toEqual([])
    // Every entry failing is an HTTP error.
    // Every entry failing is a 503, reported with the entries' own error, as the real SFU words it.
    await expect(
      client.streamToWebSocket([{ sessionId: "pub", trackName: "nope", endpoint: "wss://x.test/b" }]),
    ).rejects.toMatchObject({
      status: 503,
      code: "websocket_handshake_failed",
    })
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
    const js = await script.text()
    for (const used of [
      "campflare.huddles.join",
      "campflare.huddles.publish",
      "campflare.huddles.unpublish",
      "campflare.huddles.layer",
      "campflare.huddles.transcribe",
      "huddle_transcript",
    ]) {
      expect(js).toContain(used)
    }
    expect(js).toContain("not_found_track_error") // retried: a newcomer may not be connected yet
    const html = await (await SELF.fetch("https://campflare.test/huddle")).text()
    for (const control of [
      'id="mute"',
      'id="camera"',
      'id="with-camera"',
      'id="tiles"',
      'id="transcribe"',
      'id="transcript"',
    ])
      expect(html).toContain(control)
  })
})

const CAMERA = { mid: "1", track_name: "camera", kind: "video", rids: ["f", "h", "q"] }
const MIC = { mid: "0", track_name: "audio", kind: "audio" }

describe("video and many people", () => {
  it("joins with a microphone and a simulcast camera at once", async () => {
    const w = await workspace()
    const bob = await w.addUser("bob")
    const alex = await join(w, w.general, { mid: undefined, tracks: [MIC, CAMERA] })
    expect(sfu.calls[1]!.body).toMatchObject({
      tracks: [
        { location: "local", mid: "0", trackName: "audio" },
        { location: "local", mid: "1", trackName: "camera" },
      ],
    })
    const bobs = await join(bob, w.general)
    expect(bobs.participants[0]!.tracks).toEqual([
      { name: "audio", kind: "audio" },
      { name: "camera", kind: "video", rids: ["f", "h", "q"] },
    ])
    // A layer per subscription: the speaker's camera in full, say.
    const sub = await ok<Subscribed>(
      "campflare.huddles.subscribe",
      {
        channel: w.general,
        publications: [
          { session_id: alex.session_id, track_name: "audio" },
          { session_id: alex.session_id, track_name: "camera", rid: "f" },
        ],
      },
      bob.token,
    )
    expect(sub.tracks.map((t) => [t.track_name, t.mid])).toEqual([
      ["audio", "0"],
      ["camera", "1"],
    ])
    expect(sfu.subscriptions.get(`${sub.session_id}/1`)?.simulcast).toEqual({
      preferredRid: "f",
      priorityOrdering: "none",
      ridNotAvailable: "asciibetical",
    })

    // Then down to the quarter layer, in place.
    await ok(
      "campflare.huddles.layer",
      {
        channel: w.general,
        session_id: sub.session_id,
        mid: "1",
        publisher_session_id: alex.session_id,
        track_name: "camera",
        rid: "q",
      },
      bob.token,
    )
    expect(sfu.subscriptions.get(`${sub.session_id}/1`)?.simulcast).toMatchObject({ preferredRid: "q" })
    expect(sfu.calls.at(-1)).toMatchObject({ method: "PUT", path: expect.stringContaining("/tracks/update") })
  })

  it("refuses layers a track doesn't offer, and subscriptions that don't exist", async () => {
    const w = await workspace()
    const bob = await w.addUser("bob")
    const alex = await join(w, w.general, { mid: undefined, tracks: [MIC, CAMERA] })
    const camera = { session_id: alex.session_id, track_name: "camera" }
    await expectError(
      "campflare.huddles.subscribe",
      { channel: w.general, publications: [{ ...camera, rid: "x" }] },
      bob.token,
      "huddle_layer_not_found",
    )
    await expectError(
      "campflare.huddles.subscribe",
      { channel: w.general, publications: [{ session_id: alex.session_id, track_name: "audio", rid: "f" }] },
      bob.token,
      "huddle_layer_not_found",
    )
    const sub = await ok<Subscribed>(
      "campflare.huddles.subscribe",
      { channel: w.general, publications: [{ ...camera, rid: "h" }] },
      bob.token,
    )
    const layer = {
      channel: w.general,
      session_id: sub.session_id,
      publisher_session_id: alex.session_id,
      track_name: "camera",
    }
    // The SFU's own answer for a mid with no subscription: its recorded per-track error.
    expect(await call("campflare.huddles.layer", { ...layer, mid: "7", rid: "q" }, bob.token)).toMatchObject({
      error: "huddle_media_error",
      detail: "internal_error",
    })
    await expectError("campflare.huddles.layer", { ...layer, mid: "0", rid: "z" }, bob.token, "huddle_layer_not_found")
    await expectError(
      "campflare.huddles.layer",
      { ...layer, mid: "0", rid: "q" },
      w.owner.token,
      "huddle_session_not_found",
    )
  })

  it("turns a camera on and off mid-call, telling everyone", async () => {
    const w = await workspace()
    const bob = await w.addUser("bob")
    const link = await connect((await ok<{ url: string }>("rtm.connect", {}, bob.token)).url)
    await link.next((f) => f.type === "hello")
    const alex = await join(w, w.general)
    await link.next((f) => f.type === "huddle_joined")

    const on = await ok<{ sdp: string; tracks: string[] }>(
      "campflare.huddles.publish",
      { channel: w.general, sdp: OFFER, tracks: [CAMERA] },
      w.owner.token,
    )
    expect(on.sdp).toMatch(/^v=0/)
    expect(on.tracks).toEqual(["audio", "camera"])
    // Same publishing session: the browser renegotiated its existing connection.
    expect(sfu.calls.at(-1)).toMatchObject({ path: expect.stringContaining(`/sessions/${alex.session_id}/tracks/new`) })
    expect(await link.next((f) => f.type === "huddle_tracks")).toMatchObject({
      user: w.owner.id,
      tracks: [{ name: "audio" }, { name: "camera", kind: "video", rids: ["f", "h", "q"] }],
    })
    await expectError(
      "campflare.huddles.publish",
      { channel: w.general, sdp: OFFER, tracks: [CAMERA] },
      w.owner.token,
      "invalid_arguments",
    )

    const off = await ok<{ tracks: string[] }>(
      "campflare.huddles.unpublish",
      { channel: w.general, track_names: "camera" },
      w.owner.token,
    )
    expect(off.tracks).toEqual(["audio"])
    expect(sfu.calls.at(-1)).toMatchObject({ body: { tracks: [{ mid: "1" }], force: true } })
    expect(await link.next((f) => f.type === "huddle_tracks")).toMatchObject({ tracks: [{ name: "audio" }] })
    await expectError(
      "campflare.huddles.unpublish",
      { channel: w.general, track_names: "camera" },
      w.owner.token,
      "huddle_track_not_found",
    )
    await expectError("campflare.huddles.unpublish", { channel: w.general }, w.owner.token, "huddle_track_not_found")
    // Not in the call: nothing to add to or take from.
    await expectError(
      "campflare.huddles.publish",
      { channel: w.general, sdp: OFFER, tracks: [CAMERA] },
      bob.token,
      "huddle_not_joined",
    )
    await expectError(
      "campflare.huddles.unpublish",
      { channel: w.general, track_names: "audio" },
      bob.token,
      "huddle_not_joined",
    )
    link.close()
  })

  it("lets several people into one call, each seeing everyone before them", async () => {
    const w = await workspace()
    const people = [{ id: w.owner.id, token: w.owner.token }]
    for (const name of ["bob", "carol", "dave", "erin"]) people.push(await w.addUser(name))
    const seen: number[] = []
    for (const p of people)
      seen.push((await join(p, w.general, { mid: undefined, tracks: [MIC, CAMERA] })).participants.length)
    expect(seen).toEqual([0, 1, 2, 3, 4])
    const info = await ok<{ participants: { user: string }[] }>(
      "campflare.huddles.info",
      { channel: w.general },
      w.owner.token,
    )
    expect(info.participants.map((p) => p.user)).toEqual(people.map((p) => p.id))
  })

  it("validates the tracks offered", async () => {
    const w = await workspace()
    const bad = (tracks: unknown) =>
      expectError(
        "campflare.huddles.join",
        { channel: w.general, sdp: OFFER, tracks },
        w.owner.token,
        "invalid_arguments",
      )
    await bad([])
    await bad([{ mid: "0", track_name: "a b", kind: "audio" }])
    await bad([{ mid: "0", track_name: "screen", kind: "screen" }])
    await bad([{ mid: "0", track_name: "cam", kind: "video", rids: ["f", 1] }])
    await bad([MIC, { ...MIC, mid: "1" }])
  })
})

describe("naming the conversation", () => {
  it("takes #name, an id, or a user id (their DM), as chat.postMessage does", async () => {
    const w = await workspace()
    const bob = await w.addUser("bob")
    const joined = await join(w, "#general")
    expect(await ok("campflare.huddles.info", { channel: "#general" }, w.owner.token)).toMatchObject({
      channel: w.general,
      participants: [{ user: w.owner.id, session_id: joined.session_id }],
    })
    // A 1:1 call: name the other person, and it's your DM with them, from either side.
    const dm = await ok<{ channel: string }>("campflare.huddles.info", { channel: bob.id }, w.owner.token)
    expect(dm.channel).toMatch(/^D/)
    await join(w, bob.id)
    expect(await ok("campflare.huddles.info", { channel: w.owner.id }, bob.token)).toMatchObject({
      channel: dm.channel,
      participants: [{ user: w.owner.id }],
    })
    expect(await ok("campflare.huddles.leave", { channel: "#general" }, w.owner.token)).toEqual({
      ok: true,
      left: true,
    })
    await expectError(
      "campflare.huddles.join",
      { channel: "#nowhere", sdp: OFFER, mid: "0" },
      w.owner.token,
      "channel_not_found",
    )
  })
})
