import { SELF } from "cloudflare:test"
import { env } from "cloudflare:workers"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { Args } from "../src/api/args"
import { methods, type Actor, type Ctx } from "../src/api/context"
import { encodePacket } from "../src/huddle/audio"
import { setSfuFetch } from "../src/huddle/methods"
import { setSpeechFetch, setSummaryFetch } from "../src/huddle/scribe"
import { fakeSfu, type FakeSfu } from "./fake-sfu"
import exchanges from "./fixtures/sfu/exchanges.json"
import summaries from "./fixtures/speech/summaries.json"
import whisper from "./fixtures/speech/whisper.json"
import { call, connect, eventually, expectError, ok, workspace, type Workspace } from "./helpers"

// Huddle transcription offline: a fake SFU, Whisper answering with its
// recorded responses, and the SFU's adapter played by a WebSocket we open to
// the endpoint it was given, sending the adapter's protobuf PCM packets.

type Recorded = { operation: string; request?: { sessionDescription?: { sdp: string } } }
const OFFER = (exchanges as Recorded[]).find((e) => e.request?.sessionDescription)!.request!.sessionDescription!.sdp
const WHISPER = whisper as { lang: string; response: unknown }[]
const heard = (lang: string) => WHISPER.find((w) => w.lang === lang)!.response

let sfu: FakeSfu
let speechCalls: number
let answer: unknown
let summaryCalls: { messages: { role: string; content: string }[] }[]
const SUMMARY = (summaries as { name: string; response: unknown }[]).find((r) => r.name === "Japanese")!.response
beforeEach(() => {
  summaryCalls = []
  setSummaryFetch((async (_url: RequestInfo | URL, init?: RequestInit) => {
    summaryCalls.push(JSON.parse(String(init?.body)))
    return Response.json(SUMMARY)
  }) as typeof fetch)
  sfu = fakeSfu()
  setSfuFetch(sfu.fetch)
  speechCalls = 0
  answer = heard("ja")
  setSpeechFetch((async () => {
    speechCalls++
    return Response.json(answer)
  }) as typeof fetch)
})
afterEach(() => {
  setSfuFetch(undefined)
  setSpeechFetch(undefined)
  setSummaryFetch(undefined)
})

const join = (who: { token: string }, channel: string) =>
  ok<{ session_id: string }>("campflare.huddles.join", { channel, sdp: OFFER, mid: "0" }, who.token)

const owner = (w: Workspace) => ({ id: w.owner.id, token: w.owner.token })

/** 48 kHz stereo PCM: a tone (speech, to the segmenter) or silence, in 20 ms adapter packets. */
function packets(ms: number, amplitude: number, from = 0): Uint8Array[] {
  const out: Uint8Array[] = []
  for (let t = 0; t < ms; t += 20) {
    const pcm = new Uint8Array(960 * 4)
    const v = new DataView(pcm.buffer)
    for (let i = 0; i < 960; i++) {
      const s = Math.round(amplitude * Math.sin((2 * Math.PI * 220 * (i + t * 48)) / 48_000))
      v.setInt16(i * 4, s, true)
      v.setInt16(i * 4 + 2, s, true)
    }
    out.push(encodePacket({ sequenceNumber: from + out.length, timestamp: (from + out.length) * 960, payload: pcm }))
  }
  return out
}

/** Opens the adapter's connection, as the SFU would. */
async function stream(endpoint: string) {
  const res = await SELF.fetch(endpoint.replace(/^ws/, "http"), { headers: { upgrade: "websocket" } })
  const ws = res.webSocket
  if (!ws) throw new Error(`no websocket: ${res.status}`)
  ws.accept()
  return ws
}

type Replies = {
  messages: { text: string; user: string; metadata?: { event_type: string; event_payload: Record<string, unknown> } }[]
}

describe("campflare.huddles.transcribe", () => {
  it("opens a transcript thread and streams everyone's microphone to the scribe", async () => {
    const w = await workspace()
    const bob = await w.addUser("bob")
    await join(owner(w), w.general)
    await join(bob, w.general)
    const link = await connect((await ok<{ url: string }>("rtm.connect", {}, bob.token)).url)
    await link.next((f) => f.type === "hello")

    const on = await ok<{ active: boolean; thread_ts: string; streaming: number }>(
      "campflare.huddles.transcribe",
      { channel: "#general" },
      w.owner.token,
    )
    expect(on).toMatchObject({ active: true, streaming: 2 })
    expect(await link.next((f) => f.type === "huddle_transcription")).toMatchObject({
      active: true,
      thread_ts: on.thread_ts,
    })

    // The Huddle Scribe bot posts the thread's first message.
    const thread = await ok<Replies>("conversations.replies", { channel: w.general, ts: on.thread_ts }, w.owner.token)
    expect(thread.messages[0]!.text).toContain("Transcript of this call")
    const scribeUser = thread.messages[0]!.user
    expect(await ok("users.info", { user: scribeUser }, w.owner.token)).toMatchObject({
      user: { name: "huddle-scribe", is_bot: true },
    })

    // One adapter per microphone, each to its own ticketed endpoint.
    const adapters = [...sfu.adapters.values()]
    expect(adapters).toHaveLength(2)
    for (const a of adapters) expect(a.endpoint).toMatch(/^wss:\/\/campflare\.test\/huddle\/scribe\/[\w-]+\.[0-9a-f]+$/)
    expect(new Set(adapters.map((a) => a.endpoint)).size).toBe(2)

    // Turning it on again changes nothing.
    expect(await ok("campflare.huddles.transcribe", { channel: w.general }, bob.token)).toMatchObject({
      thread_ts: on.thread_ts,
    })
    link.close()
  })

  it("posts what each speaker says in the thread, with who and which language for agents", async () => {
    const w = await workspace()
    await join(owner(w), w.general)
    const on = await ok<{ thread_ts: string }>("campflare.huddles.transcribe", { channel: w.general }, w.owner.token)
    const ws = await stream([...sfu.adapters.values()][0]!.endpoint)
    // A second of "speech", then a second of silence: one utterance.
    for (const p of [...packets(1000, 8000), ...packets(1000, 0, 50)]) ws.send(p)

    const line = await eventually(async () => {
      const thread = await ok<Replies>("conversations.replies", { channel: w.general, ts: on.thread_ts }, w.owner.token)
      return thread.messages[1]
    })
    expect(line.text).toBe(
      "*OWNER*: デプロイが完了しました。テスト結果を確認してください。".replace("OWNER", "Olive Owner"),
    )
    expect(line.metadata).toEqual({
      event_type: "huddle_transcript",
      event_payload: {
        user: w.owner.id,
        text: "デプロイが完了しました。テスト結果を確認してください。",
        language: "ja",
        duration_ms: expect.any(Number),
      },
    })
    expect(speechCalls).toBe(1)

    // Lines that say nothing aren't posted; a closing stream flushes what was being said.
    answer = { success: true, result: { text: "  " } }
    for (const p of packets(1000, 8000, 100)) ws.send(p)
    ws.close(1000, "bye")
    await eventually(() => speechCalls === 2)
    await new Promise((r) => setTimeout(r, 100))
    const thread = await ok<Replies>("conversations.replies", { channel: w.general, ts: on.thread_ts }, w.owner.token)
    expect(thread.messages).toHaveLength(2)
  })

  it("streams newcomers once their connection is up, retrying while it isn't", async () => {
    const w = await workspace()
    const bob = await w.addUser("bob")
    await join(owner(w), w.general)
    await ok("campflare.huddles.transcribe", { channel: w.general }, w.owner.token)
    // Bob's first adapter attempt meets an SFU that can't reach him yet.
    sfu.failNext("POST /adapters/websocket/new", 503, "websocket_handshake_failed")
    const bobs = await join(bob, w.general)
    const adapter = await eventually(
      () => [...sfu.adapters.values()].find((a) => a.sessionId === bobs.session_id),
      4000,
    )
    expect(adapter.trackName).toBe("audio")
  })

  it("stops a leaver's stream, and the whole transcript with the last one out", async () => {
    const w = await workspace()
    const bob = await w.addUser("bob")
    await join(owner(w), w.general)
    const bobs = await join(bob, w.general)
    const link = await connect((await ok<{ url: string }>("rtm.connect", {}, w.owner.token)).url)
    await link.next((f) => f.type === "hello")
    await ok("campflare.huddles.transcribe", { channel: w.general }, w.owner.token)
    await link.next((f) => f.type === "huddle_transcription")

    await ok("campflare.huddles.leave", { channel: w.general }, bob.token)
    const bobsAdapter = [...sfu.adapters.values()].find((a) => a.sessionId === bobs.session_id)!
    await eventually(() => bobsAdapter.closed)
    expect([...sfu.adapters.values()].filter((a) => !a.closed)).toHaveLength(1)

    await ok("campflare.huddles.leave", { channel: w.general }, w.owner.token)
    await eventually(() => [...sfu.adapters.values()].every((a) => a.closed))
    expect(await link.next((f) => f.type === "huddle_transcription")).toMatchObject({ active: false })
    // A new call is a new transcript.
    await join(owner(w), w.general)
    const again = await ok<{ thread_ts: string }>("campflare.huddles.transcribe", { channel: w.general }, w.owner.token)
    expect(again.thread_ts).toEqual(expect.any(String))
    link.close()
  })

  it("turns off on request", async () => {
    const w = await workspace()
    await join(owner(w), w.general)
    await ok("campflare.huddles.transcribe", { channel: w.general }, w.owner.token)
    expect(await ok("campflare.huddles.transcribe", { channel: w.general, enabled: false }, w.owner.token)).toEqual({
      ok: true,
      active: false,
    })
    await eventually(() => [...sfu.adapters.values()].every((a) => a.closed))
    expect(await ok("campflare.huddles.transcribe", { channel: w.general, enabled: false }, w.owner.token)).toEqual({
      ok: true,
      active: false,
    })
  })

  it("needs a call, membership, and Workers AI configured", async () => {
    const w = await workspace()
    const bob = await w.addUser("bob")
    await expectError("campflare.huddles.transcribe", { channel: w.general }, w.owner.token, "huddle_empty")
    const { channel } = await ok<{ channel: { id: string } }>(
      "conversations.create",
      { name: "x", is_private: true },
      w.owner.token,
    )
    await expectError("campflare.huddles.transcribe", { channel: channel.id }, bob.token, "channel_not_found")

    const actor = { kind: "user", team: { id: w.teamId }, user: { id: w.owner.id }, scopes: [] } as unknown as Actor
    const ctx = {
      env: { ...env, WORKERS_AI_TOKEN: "" },
      args: new Args({ channel: w.general }),
      auth: actor,
      request: new Request("https://campflare.test/"),
      origin: "https://campflare.test",
      waitUntil: () => undefined,
    }
    await expect(methods.get("campflare.huddles.transcribe")!.handler(ctx as Ctx<Actor | undefined>)).rejects.toThrow(
      "transcription_not_configured",
    )
  })

  it("only lets the SFU in with a valid ticket, over WebSocket", async () => {
    const w = await workspace()
    await join(owner(w), w.general)
    await ok("campflare.huddles.transcribe", { channel: w.general }, w.owner.token)
    const endpoint = [...sfu.adapters.values()][0]!.endpoint.replace(/^ws/, "http")
    expect((await SELF.fetch(endpoint)).status).toBe(426)
    expect(
      (await SELF.fetch(endpoint.replace(/\.[0-9a-f]+$/, ".00"), { headers: { upgrade: "websocket" } })).status,
    ).toBe(401)
    expect((await call("api.test")).ok).toBe(true)
  })

  it("summarises the call in its thread when transcription stops, after its last words", async () => {
    const w = await workspace()
    await join(owner(w), w.general)
    const on = await ok<{ thread_ts: string }>("campflare.huddles.transcribe", { channel: w.general }, w.owner.token)
    const ws = await stream([...sfu.adapters.values()][0]!.endpoint)
    for (const p of [...packets(1000, 8000), ...packets(1000, 0, 50)]) ws.send(p)
    await eventually(() => speechCalls === 1)
    // Still speaking when it's turned off: those words are transcribed too, before the summary.
    for (const p of packets(800, 8000, 100)) ws.send(p)
    await new Promise((r) => setTimeout(r, 100))
    await ok("campflare.huddles.transcribe", { channel: w.general, enabled: false }, w.owner.token)

    const thread = await eventually(async () => {
      const t = await ok<Replies>("conversations.replies", { channel: w.general, ts: on.thread_ts }, w.owner.token)
      return t.messages.length === 4 ? t : undefined
    })
    const [, first, last, summary] = thread.messages
    expect(first!.metadata?.event_type).toBe("huddle_transcript")
    expect(last!.metadata?.event_type).toBe("huddle_transcript")
    expect(summary!.text).toMatch(/^:memo: \*Summary\*\n/)
    expect(summary!.text).toContain("木曜日")
    expect(summary!.metadata).toEqual({
      event_type: "huddle_summary",
      event_payload: { text: expect.stringContaining("木曜日"), lines: 2, language: "ja" },
    })
    // The model was told the call's language, and given who said what.
    expect(summaryCalls).toHaveLength(1)
    expect(summaryCalls[0]!.messages[0]!.content).toContain("Write in Japanese")
    expect(summaryCalls[0]!.messages[1]!.content).toMatch(/^Olive Owner: /)
  })

  it("summarises when the last person leaves, and not at all if nobody spoke", async () => {
    const w = await workspace()
    await join(owner(w), w.general)
    await ok("campflare.huddles.transcribe", { channel: w.general }, w.owner.token)
    await ok("campflare.huddles.transcribe", { channel: w.general, enabled: false }, w.owner.token)
    await new Promise((r) => setTimeout(r, 100))
    expect(summaryCalls).toHaveLength(0)

    const on = await ok<{ thread_ts: string }>("campflare.huddles.transcribe", { channel: w.general }, w.owner.token)
    const ws = await stream([...sfu.adapters.values()].at(-1)!.endpoint)
    for (const p of [...packets(1000, 8000), ...packets(1000, 0, 50)]) ws.send(p)
    await eventually(() => speechCalls === 1)
    await ok("campflare.huddles.leave", { channel: w.general }, w.owner.token)
    const summary = await eventually(async () => {
      const t = await ok<Replies>("conversations.replies", { channel: w.general, ts: on.thread_ts }, w.owner.token)
      return t.messages.find((m) => m.metadata?.event_type === "huddle_summary")
    })
    expect(summary.metadata?.event_payload).toMatchObject({ lines: 1 })
  })
})
