import { describe, expect, it } from "vitest"
import { wav } from "../src/huddle/audio"
import { createSpeech, SpeechError, WHISPER } from "../src/huddle/speech"
import whisper from "./fixtures/speech/whisper.json"

// The Workers AI client offline, against Whisper's real answers (recorded by
// tests/live/speech.live.test.ts) for the same sentence in seven languages.

type Recorded = { lang: string; status: number; response: unknown }
const recorded = whisper as Recorded[]

const replying = (body: unknown, status = 200) => {
  const seen: { url: string; init?: RequestInit }[] = []
  const fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
    seen.push({ url: String(url), init })
    return new Response(typeof body === "string" ? body : JSON.stringify(body), { status })
  }) as typeof globalThis.fetch
  return { speech: createSpeech({ accountId: "acct", token: "tok", fetch }), seen }
}

describe("createSpeech", () => {
  it("sends the WAV as base64 to Whisper on Workers AI, with the token", async () => {
    const { speech, seen } = replying(recorded[0]!.response)
    const audio = wav(new Int16Array([1, 2, 3]))
    await speech.transcribe(audio)
    expect(seen[0]!.url).toBe(`https://api.cloudflare.com/client/v4/accounts/acct/ai/run/${WHISPER}`)
    expect(new Headers(seen[0]!.init!.headers).get("authorization")).toBe("Bearer tok")
    const body = JSON.parse(String(seen[0]!.init!.body)) as { audio: string }
    expect(Uint8Array.from(atob(body.audio), (c) => c.charCodeAt(0))).toEqual(audio)
  })

  it("returns the text and language for every recorded language", async () => {
    expect(recorded.map((r) => r.lang)).toEqual(["zh", "ja", "ko", "en", "es", "fr", "de"])
    for (const r of recorded) {
      const heard = await replying(r.response).speech.transcribe(new Uint8Array(4))
      expect(heard.language).toBe(r.lang)
      expect(heard.text.length).toBeGreaterThan(10)
      expect(heard.text).toBe(heard.text.trim())
    }
  })

  it("leaves the language out when Whisper doesn't give one", async () => {
    const heard = await replying({ success: true, result: { text: " hello " } }).speech.transcribe(new Uint8Array(4))
    expect(heard).toEqual({ text: "hello" })
    expect(await replying({ success: true, result: {} }).speech.transcribe(new Uint8Array(4))).toEqual({ text: "" })
  })

  it("raises SpeechError with Workers AI's message, or the status", async () => {
    await expect(
      replying({ success: false, errors: [{ code: 10000, message: "Authentication error" }] }, 401).speech.transcribe(
        new Uint8Array(4),
      ),
    ).rejects.toMatchObject({
      status: 401,
      code: "Authentication error",
    })
    await expect(replying("<html>", 502).speech.transcribe(new Uint8Array(4))).rejects.toBeInstanceOf(SpeechError)
    await expect(replying("<html>", 502).speech.transcribe(new Uint8Array(4))).rejects.toMatchObject({
      code: "http_502",
    })
  })

  it("encodes long audio without overflowing the call stack", async () => {
    const { speech, seen } = replying(recorded[3]!.response)
    await speech.transcribe(new Uint8Array(200_000).fill(7))
    expect((JSON.parse(String(seen[0]!.init!.body)) as { audio: string }).audio.length).toBe(Math.ceil(200_000 / 3) * 4)
  })
})
