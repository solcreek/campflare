import { execFileSync } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

// One sentence in seven languages, scripts evenly (Chinese, Japanese, Korean,
// and English, Spanish, French, German), spoken by macOS \`say\`: real speech
// for live speech-recognition tests.

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
