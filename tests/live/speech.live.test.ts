import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { describe, expect, it } from "vitest"
import { createSpeech } from "../../apps/server/src/huddle/speech.ts"
import { devVars } from "./env.ts"

// Workers AI Whisper, live, on speech that macOS `say` reads in seven
// languages, scripts evenly: Chinese, Japanese, Korean, and English, Spanish,
// French, German. With RECORD_FIXTURES=1 the responses are saved for the
// offline tests.

const env = devVars()
const hasSay = existsSync("/usr/bin/say") && existsSync("/usr/bin/afconvert")
const configured = Boolean(env.CF_ACCOUNT_ID && env.WORKERS_AI_TOKEN) && hasSay
const FIXTURES = resolve(import.meta.dirname, "../../apps/server/test/fixtures/speech")

export const PHRASES = [
  { lang: "zh", voice: "Meijia", text: "部署已經完成，請大家確認測試結果。", expect: /部署/ },
  { lang: "ja", voice: "Kyoko", text: "デプロイが完了しました。テスト結果を確認してください。", expect: /テスト/ },
  { lang: "ko", voice: "Yuna", text: "배포가 완료되었습니다. 테스트 결과를 확인해 주세요.", expect: /테스트/ },
  {
    lang: "en",
    voice: "Samantha",
    text: "The deployment is finished. Please check the test results.",
    expect: /deployment/i,
  },
  {
    lang: "es",
    voice: "Mónica",
    text: "El despliegue ha terminado. Por favor revisen los resultados.",
    expect: /despliegue/i,
  },
  {
    lang: "fr",
    voice: "Jacques",
    text: "Le déploiement est terminé. Merci de vérifier les résultats.",
    expect: /déploiement/i,
  },
  {
    lang: "de",
    voice: "Anna",
    text: "Die Bereitstellung ist abgeschlossen. Bitte prüft die Ergebnisse.",
    expect: /Bereitstellung/i,
  },
]

/** A phrase spoken by `say`, as a 16 kHz mono WAV. */
export function spoken(phrase: (typeof PHRASES)[number], rate = "LEI16@16000", channels = 1): Uint8Array {
  const dir = mkdtempSync(join(tmpdir(), "campflare-say-"))
  try {
    execFileSync("say", ["-v", phrase.voice, "-o", join(dir, "a.aiff"), phrase.text])
    execFileSync("afconvert", [
      "-f",
      "WAVE",
      "-d",
      rate,
      "-c",
      String(channels),
      join(dir, "a.aiff"),
      join(dir, "a.wav"),
    ])
    return new Uint8Array(readFileSync(join(dir, "a.wav")))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

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
