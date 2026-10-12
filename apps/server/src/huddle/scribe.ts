import { DurableObject } from "cloudflare:workers"
import { Args } from "../api/args"
import type { Actor, Ctx } from "../api/context"
import { postMessage } from "../db/messages"
import { first } from "../db/query"
import type { ConversationRow, TeamRow, UserRow } from "../db/rows"
import type { Env } from "../env"
import { decodePacket, Segmenter, toMono16k, wav } from "./audio"
import { scribeActor } from "./scribe-bot"
import { createSpeech } from "./speech"
import { createSummarizer, dominantLanguage, type TranscriptLine } from "./summary"

// HuddleScribe: one per conversation's call. The SFU connects to it once per
// speaker (a WebSocket adapter streaming their microphone as PCM); it cuts
// each speaker's audio into utterances, transcribes them with Whisper, and
// the Huddle Scribe bot posts each line in the call's transcript thread, with
// machine-readable metadata (who, which language) for agents. When
// transcription stops, it summarises the call in the same thread.

let speechFetch: typeof fetch | undefined
let summaryFetch: typeof fetch | undefined

/** For tests, which run in the Worker's isolate: answer Workers AI without the network. */
export function setSpeechFetch(fetcher: typeof fetch | undefined) {
  speechFetch = fetcher
}

export function setSummaryFetch(fetcher: typeof fetch | undefined) {
  summaryFetch = fetcher
}

export interface ScribeConfig {
  teamId: string
  channelId: string
  /** The transcript thread's parent message. */
  threadTs: string
  /** The origin URLs in posted messages are built on. */
  origin: string
}

interface Speaker {
  user: string
}

export class HuddleScribe extends DurableObject<Env> {
  private segmenters = new Map<string, Segmenter>()
  /** Lines are transcribed and posted one at a time, in the order they were spoken; the summary comes after them all. */
  private queue: Promise<unknown> = Promise.resolve()

  async start(config: ScribeConfig): Promise<void> {
    await this.ctx.storage.put("config", config)
    await this.ctx.storage.put("adapters", {})
    await this.ctx.storage.delete("lines")
  }

  /**
   * Ends transcription: what each speaker was in the middle of saying is still
   * transcribed, then the call is summarised in the thread. Returns the
   * adapters, for the caller to close at the SFU.
   */
  async stop(): Promise<Record<string, string>> {
    const config = await this.ctx.storage.get<ScribeConfig>("config")
    const adapters = (await this.ctx.storage.get<Record<string, string>>("adapters")) ?? {}
    if (config) {
      for (const [user, segmenter] of this.segmenters) {
        const rest = segmenter.flush()
        if (rest) this.enqueue(config, user, rest)
      }
    }
    this.segmenters.clear()
    await this.ctx.storage.delete(["config", "adapters"])
    for (const ws of this.ctx.getWebSockets()) ws.close(1000, "transcription stopped")
    if (config) this.after(() => this.summarize(config), "summary")
    return adapters
  }

  async status(): Promise<{ config?: ScribeConfig; adapters: Record<string, string> }> {
    return {
      config: await this.ctx.storage.get<ScribeConfig>("config"),
      adapters: (await this.ctx.storage.get<Record<string, string>>("adapters")) ?? {},
    }
  }

  async addAdapter(user: string, adapterId: string): Promise<void> {
    const adapters = (await this.ctx.storage.get<Record<string, string>>("adapters")) ?? {}
    await this.ctx.storage.put("adapters", { ...adapters, [user]: adapterId })
  }

  async removeAdapter(user: string): Promise<string | undefined> {
    const adapters = (await this.ctx.storage.get<Record<string, string>>("adapters")) ?? {}
    const adapterId = adapters[user]
    delete adapters[user]
    await this.ctx.storage.put("adapters", adapters)
    return adapterId
  }

  /** The SFU's connection for one speaker, already authenticated by the Worker. */
  override async fetch(request: Request): Promise<Response> {
    const speaker = JSON.parse(request.headers.get("x-campflare-speaker") ?? "null") as Speaker | null
    if (!speaker || request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      return new Response("expected a websocket", { status: 426 })
    }
    const pair = new WebSocketPair()
    this.ctx.acceptWebSocket(pair[1], [speaker.user])
    pair[1].serializeAttachment(speaker)
    return new Response(null, { status: 101, webSocket: pair[0] })
  }

  override async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message === "string") return
    const config = await this.ctx.storage.get<ScribeConfig>("config")
    if (!config) return
    const speaker = ws.deserializeAttachment() as Speaker
    let packet
    try {
      packet = decodePacket(new Uint8Array(message))
    } catch {
      return // a malformed frame shouldn't end the stream
    }
    let segmenter = this.segmenters.get(speaker.user)
    if (!segmenter) {
      segmenter = new Segmenter()
      this.segmenters.set(speaker.user, segmenter)
    }
    for (const utterance of segmenter.push(toMono16k(packet.payload))) this.enqueue(config, speaker.user, utterance)
  }

  override async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    const speaker = ws.deserializeAttachment() as Speaker | null
    const config = await this.ctx.storage.get<ScribeConfig>("config")
    const rest = speaker ? this.segmenters.get(speaker.user)?.flush() : undefined
    if (speaker && rest && config) this.enqueue(config, speaker.user, rest)
    if (speaker) this.segmenters.delete(speaker.user)
    try {
      ws.close(code === 1005 ? 1000 : code, reason)
    } catch {
      // already closed
    }
  }

  private enqueue(config: ScribeConfig, user: string, utterance: Int16Array) {
    this.after(() => this.transcribe(config, user, utterance), "transcription")
  }

  /** Runs `work` after everything queued before it, keeping the object alive until it's done. */
  private after(work: () => Promise<void>, what: string) {
    const next = this.queue.then(work).catch((error: unknown) => console.error(`${what} failed`, error))
    this.queue = next
    this.ctx.waitUntil(next)
  }

  /** Transcribes one utterance and posts it in the thread, as the Huddle Scribe. */
  private async transcribe(config: ScribeConfig, user: string, utterance: Int16Array): Promise<void> {
    if (!this.env.CF_ACCOUNT_ID || !this.env.WORKERS_AI_TOKEN) return
    const speech = createSpeech({
      accountId: this.env.CF_ACCOUNT_ID,
      token: this.env.WORKERS_AI_TOKEN,
      fetch: speechFetch,
    })
    const heard = await speech.transcribe(wav(utterance))
    if (!heard.text) return
    const person = await first<UserRow>(this.env.DB, "SELECT * FROM users WHERE id = ?", user)
    const name = person?.display_name || person?.real_name || person?.name || user
    const posted = await this.post(config, `*${name}*: ${heard.text}`, {
      event_type: "huddle_transcript",
      event_payload: {
        user,
        text: heard.text,
        ...(heard.language ? { language: heard.language } : {}),
        duration_ms: Math.round((utterance.length / 16_000) * 1000),
      },
    })
    if (!posted) return
    // Kept for the summary at the end.
    const lines = (await this.ctx.storage.get<TranscriptLine[]>("lines")) ?? []
    lines.push({ name, text: heard.text, ...(heard.language ? { language: heard.language } : {}) })
    await this.ctx.storage.put("lines", lines)
  }

  /** The summary of what was transcribed, posted in the thread; nothing if nobody spoke. */
  private async summarize(config: ScribeConfig): Promise<void> {
    const lines = (await this.ctx.storage.get<TranscriptLine[]>("lines")) ?? []
    await this.ctx.storage.delete("lines")
    if (lines.length === 0 || !this.env.CF_ACCOUNT_ID || !this.env.WORKERS_AI_TOKEN) return
    const summarizer = createSummarizer({
      accountId: this.env.CF_ACCOUNT_ID,
      token: this.env.WORKERS_AI_TOKEN,
      fetch: summaryFetch,
    })
    const summary = await summarizer.summarize(lines)
    if (!summary) return
    const language = dominantLanguage(lines)
    await this.post(config, `:memo: *Summary*\n${summary}`, {
      event_type: "huddle_summary",
      event_payload: { text: summary, lines: lines.length, ...(language ? { language } : {}) },
    })
  }

  /** Posts in the transcript thread as the Huddle Scribe. */
  private async post(config: ScribeConfig, text: string, metadata: Record<string, unknown>): Promise<boolean> {
    const team = await first<TeamRow>(this.env.DB, "SELECT * FROM teams WHERE id = ?", config.teamId)
    const conversation = await first<ConversationRow>(
      this.env.DB,
      "SELECT * FROM conversations WHERE id = ?",
      config.channelId,
    )
    if (!team || !conversation) return false
    const actor = await scribeActor(this.env, team)
    const ctx: Ctx<Actor> = {
      env: this.env,
      args: new Args({}),
      auth: actor,
      request: new Request(config.origin),
      origin: config.origin,
      waitUntil: (p) => this.ctx.waitUntil(p),
    }
    await postMessage(ctx, conversation, {
      user_id: actor.user.id,
      bot_id: actor.app!.bot_id,
      app_id: actor.app!.id,
      text,
      thread_ts: config.threadTs,
      metadata: JSON.stringify(metadata),
    })
    return true
  }
}
