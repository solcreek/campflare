// Speech to text through Workers AI's REST API: Whisper large v3 turbo,
// which recognises many languages and says which it heard. REST (with an
// account-scoped token) rather than the AI binding, so local development
// needs no wrangler login, and tests can stand in for the network.

export const WHISPER = "@cf/openai/whisper-large-v3-turbo"

export interface Transcript {
  text: string
  /** The language Whisper detected, as an ISO 639-1 code ("zh", "es"…), when it says. */
  language?: string
}

export class SpeechError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(`speech recognition failed (${status}): ${code}`)
  }
}

export interface SpeechOptions {
  accountId: string
  token: string
  fetch?: typeof fetch
}

function base64(bytes: Uint8Array): string {
  let binary = ""
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(binary)
}

export function createSpeech(options: SpeechOptions) {
  const fetcher = options.fetch ?? ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, init))
  return {
    /** Transcribes one utterance (a WAV file). */
    async transcribe(wavBytes: Uint8Array): Promise<Transcript> {
      const res = await fetcher(
        `https://api.cloudflare.com/client/v4/accounts/${options.accountId}/ai/run/${WHISPER}`,
        {
          method: "POST",
          headers: { authorization: `Bearer ${options.token}`, "content-type": "application/json" },
          body: JSON.stringify({ audio: base64(wavBytes) }),
        },
      )
      const body = (await res.json().catch(() => ({}))) as {
        success?: boolean
        errors?: { code?: number; message?: string }[]
        result?: { text?: string; transcription_info?: { language?: string } }
      }
      if (!res.ok || !body.success) {
        const error = body.errors?.[0]
        throw new SpeechError(res.status, error?.message ?? `http_${res.status}`)
      }
      const language = body.result?.transcription_info?.language
      return { text: (body.result?.text ?? "").trim(), ...(language ? { language } : {}) }
    },
  }
}

export type Speech = ReturnType<typeof createSpeech>
