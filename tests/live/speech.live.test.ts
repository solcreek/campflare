import { existsSync, mkdirSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { describe, expect, it } from "vitest"
import { createSpeech } from "../../apps/server/src/huddle/speech.ts"
import { devVars } from "./env.ts"
import { PHRASES, spoken } from "./voices.ts"

// Workers AI Whisper, live, on speech that macOS `say` reads in seven
// languages, scripts evenly: Chinese, Japanese, Korean, and English, Spanish,
// French, German. With RECORD_FIXTURES=1 the responses are saved for the
// offline tests.

const env = devVars()
const hasSay = existsSync("/usr/bin/say") && existsSync("/usr/bin/afconvert")
const configured = Boolean(env.CF_ACCOUNT_ID && env.WORKERS_AI_TOKEN) && hasSay
const FIXTURES = resolve(import.meta.dirname, "../../apps/server/test/fixtures/speech")

describe.skipIf(!configured)("Workers AI Whisper (live)", () => {
  it("transcribes seven languages and names each", async () => {
    const record: { lang: string; status: number; response: unknown }[] = []
    const speech = createSpeech({
      accountId: env.CF_ACCOUNT_ID!,
      token: env.WORKERS_AI_TOKEN!,
      fetch: async (input, init) => {
        const res = await fetch(input, init)
        record.push({ lang: "", status: res.status, response: await res.clone().json() })
        return res
      },
    })
    const heard: Record<string, { text: string; language?: string }> = {}
    for (const phrase of PHRASES) {
      heard[phrase.lang] = await speech.transcribe(spoken(phrase))
      record.at(-1)!.lang = phrase.lang
    }
    console.log(
      Object.entries(heard)
        .map(([l, t]) => `${l}: ${t.language} "${t.text}"`)
        .join("\n"),
    )
    for (const phrase of PHRASES) {
      expect(heard[phrase.lang]!.text).toMatch(phrase.expect)
      expect(heard[phrase.lang]!.language).toBe(phrase.lang)
    }
    if (env.RECORD_FIXTURES) {
      mkdirSync(FIXTURES, { recursive: true })
      writeFileSync(join(FIXTURES, "whisper.json"), `${JSON.stringify(record, null, 2)}\n`)
    }
  })
})
