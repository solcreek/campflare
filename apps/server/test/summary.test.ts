import { describe, expect, it } from "vitest"
import { createSummarizer, dominantLanguage, SUMMARY_MODEL, SummaryError } from "../src/huddle/summary"
import summaries from "./fixtures/speech/summaries.json"

// The summary client offline, against the model's recorded answers
// (tests/live/summary.live.test.ts) for calls in different languages.

type Recorded = { name: string; response: unknown }
const recorded = summaries as Recorded[]

function replying(body: unknown, status = 200) {
  const seen: { url: string; body: { messages: { role: string; content: string }[] } }[] = []
  const fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
    seen.push({ url: String(url), body: JSON.parse(String(init?.body)) })
    return new Response(typeof body === "string" ? body : JSON.stringify(body), { status })
  }) as typeof globalThis.fetch
  return { summarizer: createSummarizer({ accountId: "acct", token: "tok", fetch }), seen }
}

describe("dominantLanguage", () => {
  it("weighs languages by how much was said in each", () => {
    expect(dominantLanguage([])).toBeUndefined()
    expect(dominantLanguage([{ name: "a", text: "hola" }])).toBeUndefined()
    expect(
      dominantLanguage([
        { name: "a", text: "我們今天要決定部署時間", language: "zh" },
        { name: "b", text: "Thursday", language: "en" },
        { name: "c", text: "好", language: "zh" },
      ]),
    ).toBe("zh")
    // One long English line outweighs two short Japanese ones.
    expect(
      dominantLanguage([
        { name: "a", text: "はい", language: "ja" },
        { name: "b", text: "We should ship the release on Thursday after the tests.", language: "en" },
        { name: "c", text: "はい", language: "ja" },
      ]),
    ).toBe("en")
  })
})

describe("createSummarizer", () => {
  it("sends the transcript with instructions naming the call's language", async () => {
    const { summarizer, seen } = replying(recorded[0]!.response)
    await summarizer.summarize([
      { name: "Alex", text: "週四部署", language: "zh" },
      { name: "Vincent", text: "OK", language: "en" },
    ])
    expect(seen[0]!.url).toBe(`https://api.cloudflare.com/client/v4/accounts/acct/ai/run/${SUMMARY_MODEL}`)
    const [system, user] = seen[0]!.body.messages
    expect(system).toMatchObject({ role: "system", content: expect.stringContaining("Write in Chinese") })
    expect(user).toEqual({ role: "user", content: "Alex: 週四部署\nVincent: OK" })
    const unknown = replying(recorded[0]!.response)
    await unknown.summarizer.summarize([{ name: "a", text: "x" }])
    expect(unknown.seen[0]!.body.messages[0]!.content).toContain("Write in the language most of the call used.")
  })

  it("reads the recorded summaries, in each language", async () => {
    expect(recorded.map((r) => r.name)).toEqual(["mostly Chinese, mixed", "Spanish", "Japanese"])
    const texts = await Promise.all(
      recorded.map((r) => replying(r.response).summarizer.summarize([{ name: "a", text: "x" }])),
    )
    expect(texts[0]).toMatch(/週四/)
    expect(texts[1]).toMatch(/jueves/)
    expect(texts[2]).toMatch(/木曜/)
    for (const t of texts) expect(t).toBe(t.trim())
  })

  it("takes { response } as well as OpenAI-style choices", async () => {
    expect(await replying({ success: true, result: { response: " short " } }).summarizer.summarize([])).toBe("short")
    expect(
      await replying({ success: true, result: { choices: [{ message: { content: "chosen" } }] } }).summarizer.summarize(
        [],
      ),
    ).toBe("chosen")
    expect(await replying({ success: true, result: {} }).summarizer.summarize([])).toBe("")
  })

  it("raises SummaryError with Workers AI's message, or the status", async () => {
    await expect(
      replying({ success: false, errors: [{ message: "Rate limited" }] }, 429).summarizer.summarize([]),
    ).rejects.toMatchObject({
      status: 429,
      code: "Rate limited",
    })
    await expect(replying("nope", 500).summarizer.summarize([])).rejects.toBeInstanceOf(SummaryError)
  })
})
