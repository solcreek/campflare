import { mkdirSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { describe, expect, it } from "vitest"
import { createSummarizer } from "../../apps/server/src/huddle/summary.ts"
import { devVars } from "./env.ts"

// The summary model, live, on transcripts in different languages, scripts
// evenly; with RECORD_FIXTURES=1 its answers are saved for offline tests.

const env = devVars()
const configured = Boolean(env.CF_ACCOUNT_ID && env.WORKERS_AI_TOKEN)
const FIXTURES = resolve(import.meta.dirname, "../../apps/server/test/fixtures/speech")

const CALLS = [
  {
    name: "mostly Chinese, mixed",
    // Chinese throughout, not English with Chinese bits: the summary follows the dominant language.
    expect: /^[^a-z]*[週周星][^]*$/u,
    lines: [
      { name: "Alex", text: "我們今天要決定 staging 的部署時間。", language: "zh" },
      { name: "Vincent", text: "I think Thursday morning works, after the migration fix lands.", language: "en" },
      { name: "Minjun", text: "El problema de la migración ya está resuelto, lo probé ayer.", language: "es" },
      { name: "Alex", text: "好，那就週四早上十點部署，Vincent 負責 rollback 計畫，我來通知客戶。", language: "zh" },
    ],
  },
  {
    name: "Spanish",
    expect: /jueves/i,
    lines: [
      { name: "Ada", text: "Tenemos que decidir cuándo publicar la nueva versión.", language: "es" },
      { name: "Vincent", text: "El jueves por la mañana, después de las pruebas.", language: "es" },
      { name: "Ada", text: "De acuerdo. Yo preparo las notas de la versión.", language: "es" },
    ],
  },
  {
    name: "Japanese",
    expect: /木曜/,
    lines: [
      { name: "Minjun", text: "リリースの日程を決めましょう。", language: "ja" },
      { name: "Ada", text: "木曜日の午前にしましょう。テストは水曜日に終わります。", language: "ja" },
      { name: "Minjun", text: "わかりました。私がリリースノートを書きます。", language: "ja" },
    ],
  },
]

describe.skipIf(!configured)("call summaries (live)", () => {
  it("summarises in the call's language, with decisions and owners", async () => {
    const record: { name: string; status: number; response: unknown }[] = []
    const summarizer = createSummarizer({
      accountId: env.CF_ACCOUNT_ID!,
      token: env.WORKERS_AI_TOKEN!,
      fetch: async (input, init) => {
        const res = await fetch(input, init)
        record.push({ name: "", status: res.status, response: await res.clone().json() })
        return res
      },
    })
    for (const call of CALLS) {
      const summary = await summarizer.summarize(call.lines)
      record.at(-1)!.name = call.name
      console.log(`--- ${call.name}\n${summary}`)
      expect(summary).toMatch(call.expect)
    }
    if (env.RECORD_FIXTURES) {
      mkdirSync(FIXTURES, { recursive: true })
      writeFileSync(join(FIXTURES, "summaries.json"), `${JSON.stringify(record, null, 2)}\n`)
    }
  })
})
