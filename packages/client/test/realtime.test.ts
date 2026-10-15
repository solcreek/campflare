import { afterEach, describe, expect, it, vi } from "vitest"
import { createClient, listen, type Fetch, type RealtimeEvent } from "../src/index"

// A WebSocket stand-in the test drives by hand.
class FakeSocket extends EventTarget {
  static all: FakeSocket[] = []
  sent: string[] = []
  closed = false
  constructor(readonly url: string) {
    super()
    FakeSocket.all.push(this)
  }
  send(data: string) {
    this.sent.push(data)
  }
  close() {
    if (this.closed) return
    this.closed = true
    this.dispatchEvent(new Event("close"))
  }
  receive(frame: unknown) {
    this.dispatchEvent(new MessageEvent("message", { data: typeof frame === "string" ? frame : JSON.stringify(frame) }))
  }
}

const tick = () => new Promise((r) => setTimeout(r, 0))

function server(urls: (string | Error)[]) {
  const fetch: Fetch = async () => {
    const next = urls.shift()
    if (next === undefined) return Response.json({ ok: false, error: "gone" })
    if (next instanceof Error) return Response.json({ ok: false, error: next.message })
    return Response.json({ ok: true, url: next })
  }
  return createClient({ url: "https://x.test", token: "xapp-1", fetch })
}

afterEach(() => {
  FakeSocket.all = []
  vi.useRealTimers()
})

describe("listen (socket mode)", () => {
  it("acks envelopes, emits events, and refreshes without a gap", async () => {
    const events: RealtimeEvent[] = []
    const statuses: string[] = []
    const l = listen({
      client: server(["wss://a", "wss://b"]),
      mode: "socket",
      onEvent: (e) => events.push(e),
      onStatus: (s) => statuses.push(s),
      WebSocket: FakeSocket as unknown as typeof WebSocket,
    })
    await tick()
    const a = FakeSocket.all[0]!
    a.receive({ type: "hello" })
    a.receive({ type: "events_api", envelope_id: "e1", payload: { event: { type: "message", text: "hi" } } })
    a.receive({ type: "events_api", envelope_id: "e2", payload: {} })
    a.receive("garbage")
    expect(a.sent).toEqual([JSON.stringify({ envelope_id: "e1" }), JSON.stringify({ envelope_id: "e2" })])
    expect(events).toEqual([{ type: "message", text: "hi" }])

    // The server asks for a refresh: b opens, says hello, and a is retired quietly.
    a.receive({ type: "disconnect", reason: "refresh_requested" })
    await tick()
    const b = FakeSocket.all[1]!
    b.receive({ type: "hello" })
    expect(a.closed).toBe(true)
    expect(statuses).toEqual(["connecting", "connected"])
    b.receive({ type: "events_api", envelope_id: "e3", payload: { event: { type: "reaction_added" } } })
    expect(events.at(-1)).toEqual({ type: "reaction_added" })
    l.close()
    expect(b.closed).toBe(true)
  })

  it("reconnects with backoff after an unexpected close or a failed open", async () => {
    vi.useFakeTimers()
    const statuses: string[] = []
    const l = listen({
      client: server(["wss://a", new Error("ratelimited"), "wss://c"]),
      mode: "socket",
      onEvent: () => undefined,
      onStatus: (s, d) => statuses.push(d ? `${s}:${d}` : s),
      WebSocket: FakeSocket as unknown as typeof WebSocket,
      minDelayMs: 10,
    })
    await vi.advanceTimersByTimeAsync(0)
    FakeSocket.all[0]!.receive({ type: "hello" })
    FakeSocket.all[0]!.close()
    expect(statuses.at(-1)).toBe("disconnected")
    await vi.advanceTimersByTimeAsync(10) // second open fails
    expect(statuses.at(-1)).toBe("disconnected:apps.connections.open failed: ratelimited")
    await vi.advanceTimersByTimeAsync(20)
    expect(FakeSocket.all).toHaveLength(2)
    FakeSocket.all[1]!.receive({ type: "hello" })
    expect(statuses.at(-1)).toBe("connected")
    l.close()
  })

  it("drops a replacement that closes before its hello, and a refresh whose open fails", async () => {
    const l = listen({
      client: server(["wss://a", "wss://b", new Error("nope")]),
      mode: "socket",
      onEvent: () => undefined,
      WebSocket: FakeSocket as unknown as typeof WebSocket,
    })
    await tick()
    const a = FakeSocket.all[0]!
    a.receive({ type: "hello" })
    a.receive({ type: "disconnect" })
    await tick()
    FakeSocket.all[1]!.close() // the replacement dies first; a stays
    expect(a.closed).toBe(false)
    a.receive({ type: "disconnect" })
    await tick()
    expect(a.closed).toBe(true) // no new link to be had: close, and retry
    l.close()
  })
})

describe("listen (rtm)", () => {
  it("passes events through and ignores pongs", async () => {
    const events: RealtimeEvent[] = []
    const l = listen({
      client: server(["wss://r"]),
      mode: "rtm",
      onEvent: (e) => events.push(e),
      WebSocket: FakeSocket as unknown as typeof WebSocket,
    })
    await tick()
    const r = FakeSocket.all[0]!
    r.receive({ type: "hello" })
    r.receive({ type: "message", text: "x" })
    r.receive({ type: "pong" })
    r.receive({ type: "disconnect" })
    r.receive({ no: "type" })
    expect(events).toEqual([{ type: "message", text: "x" }, { type: "disconnect" }])
    l.close()
  })

  it("sends frames on the live link only, once it said hello", async () => {
    const l = listen({
      client: server(["wss://r", "wss://s"]),
      mode: "rtm",
      onEvent: () => undefined,
      WebSocket: FakeSocket as unknown as typeof WebSocket,
      minDelayMs: 1,
    })
    await tick()
    const r = FakeSocket.all[0]!
    expect(l.send({ type: "campflare.active", active: true })).toBe(false)
    r.receive({ type: "hello" })
    expect(l.send({ type: "campflare.active", active: true })).toBe(true)
    expect(r.sent).toEqual(['{"type":"campflare.active","active":true}'])
    r.send = () => {
      throw new Error("closing")
    }
    expect(l.send({ type: "campflare.active", active: false })).toBe(false)
    r.close()
    expect(l.send({ type: "campflare.active", active: false })).toBe(false)
    l.close()
  })

  it("closing before the link opens leaves nothing behind", async () => {
    const l = listen({
      client: server(["wss://r"]),
      mode: "rtm",
      onEvent: () => undefined,
      WebSocket: FakeSocket as unknown as typeof WebSocket,
    })
    l.close()
    await tick()
    expect(FakeSocket.all).toHaveLength(0)
  })
})
