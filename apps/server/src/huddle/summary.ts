// A call's summary, written by a Workers AI text model from its transcript:
// what was discussed, what was decided, who does what. In the language the
// call mostly used. REST, like speech.ts, so tests can stand in for it.

export const SUMMARY_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast"

export interface TranscriptLine {
  name: string
  text: string
  /** What Whisper heard it as (ISO 639-1), when it said. */
  language?: string
}

/** The language most of the call was in, by how much was said in each. */
export function dominantLanguage(lines: TranscriptLine[]): string | undefined {
  const amount = new Map<string, number>()
  for (const l of lines) if (l.language) amount.set(l.language, (amount.get(l.language) ?? 0) + [...l.text].length)
  return [...amount].toSorted((a, b) => b[1] - a[1])[0]?.[0]
}

/** "zh" → "Chinese": a name the model follows more reliably than a code. */
function languageName(code: string): string {
  try {
    return new Intl.DisplayNames(["en"], { type: "language" }).of(code) ?? code
  } catch {
    return code
  }
}

const INSTRUCTIONS = (
  language: string | undefined,
) => `You summarise a voice call's transcript for the people who were in it.
${language ? `Write in ${languageName(language)}, the language most of the call used.` : "Write in the language most of the call used."}
Give a summary of two sentences, then the decisions made, then action items with their owners.
Leave out a heading that has nothing under it. Plain text with short lines; no Markdown headings or tables.
Use only what the transcript says.`

export class SummaryError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(`summary failed (${status}): ${code}`)
  }
}

export function createSummarizer(options: { accountId: string; token: string; fetch?: typeof fetch }) {
  const fetcher = options.fetch ?? ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, init))
  return {
    async summarize(lines: TranscriptLine[]): Promise<string> {
      const transcript = lines.map((l) => `${l.name}: ${l.text}`).join("\n")
      const res = await fetcher(
        `https://api.cloudflare.com/client/v4/accounts/${options.accountId}/ai/run/${SUMMARY_MODEL}`,
        {
          method: "POST",
          headers: { authorization: `Bearer ${options.token}`, "content-type": "application/json" },
          body: JSON.stringify({
            messages: [
              { role: "system", content: INSTRUCTIONS(dominantLanguage(lines)) },
              { role: "user", content: transcript },
            ],
            max_tokens: 800,
          }),
        },
      )
      const body = (await res.json().catch(() => ({}))) as {
        success?: boolean
        errors?: { message?: string }[]
        result?: { response?: string; choices?: { message?: { content?: string } }[] }
      }
      if (!res.ok || !body.success)
        throw new SummaryError(res.status, body.errors?.[0]?.message ?? `http_${res.status}`)
      // Some models answer { response }, others OpenAI-style choices.
      return (body.result?.response ?? body.result?.choices?.[0]?.message?.content ?? "").trim()
    },
  }
}
