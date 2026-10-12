import { DurableObject } from "cloudflare:workers"
import { Args } from "../api/args"
import type { Actor, Ctx } from "../api/context"
import { first } from "../db/query"
import { postMessage } from "../db/messages"
import type { ConversationRow, TeamRow, UserRow } from "../db/rows"
import type { Env } from "../env"
import { decodePacket, Segmenter, toMono16k, wav } from "./audio"
import { scribeActor } from "./scribe-bot"
import { createSpeech } from "./speech"

// HuddleScribe: one per conversation's call. The SFU connects to it once per
// speaker (a WebSocket adapter streaming their microphone as PCM); it cuts
// each speaker's audio into utterances, transcribes them with Whisper, and
// the Huddle Scribe bot posts each line in the call's transcript thread, with
// machine-readable metadata (who, which language) for agents.

let speechFetch: typeof fetch | undefined

/** For tests, which run in the Worker's isolate: answer Workers AI without the network. */
export function setSpeechFetch(fetcher: typeof fetch | undefined) {
  speechFetch = fetcher
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
  /** Lines are transcribed and posted one at a time, in the order they were spoken. */
  private queue: Promise<unknown> = Promise.resolve()

  async start(config: ScribeConfig): Promise<void> {
    await this.ctx.storage.put("config", config)
    await this.ctx.storage.put("adapters", {})
  }

  async stop(): Promise<Record<string, string>> {
    const adapters = (await this.ctx.storage.get<Record<string, string>>("adapters")) ?? {}
    await this.ctx.storage.delete(["config", "adapters"])
    for (const ws of this.ctx.getWebSockets()) ws.close(1000, "transcription stopped")
    this.segmenters.clear()
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
    for (const utterance of segmenter.push(toMono16k(packet.payload))) this.enqueue(speaker.user, utterance)
  }

  override async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    const speaker = ws.deserializeAttachment() as Speaker | null
    const rest = speaker ? this.segmenters.get(speaker.user)?.flush() : undefined
    if (speaker && rest) this.enqueue(speaker.user, rest)
    if (speaker) this.segmenters.delete(speaker.user)
    try {
      ws.close(code === 1005 ? 1000 : code, reason)
    } catch {
      // already closed
    }
  }

  private enqueue(user: string, utterance: Int16Array) {
    const work = this.queue
      .then(() => this.transcribe(user, utterance))
      .catch((error: unknown) => {
        console.error("transcription failed", error)
      })
    this.queue = work
    this.ctx.waitUntil(work)
  }

  /** Transcribes one utterance and posts it in the thread, as the Huddle Scribe. */
  private async transcribe(user: string, utterance: Int16Array): Promise<void> {
    const config = await this.ctx.storage.get<ScribeConfig>("config")
    if (!config || !this.env.CF_ACCOUNT_ID || !this.env.WORKERS_AI_TOKEN) return
    const speech = createSpeech({
      accountId: this.env.CF_ACCOUNT_ID,
      token: this.env.WORKERS_AI_TOKEN,
      fetch: speechFetch,
    })
    const heard = await speech.transcribe(wav(utterance))
    if (!heard.text) return
    const team = await first<TeamRow>(this.env.DB, "SELECT * FROM teams WHERE id = ?", config.teamId)
    const conversation = await first<ConversationRow>(
      this.env.DB,
      "SELECT * FROM conversations WHERE id = ?",
      config.channelId,
    )
    const person = await first<UserRow>(this.env.DB, "SELECT * FROM users WHERE id = ?", user)
    if (!team || !conversation) return
    const actor = await scribeActor(this.env, team)
    const ctx: Ctx<Actor> = {
      env: this.env,
      args: new Args({}),
      auth: actor,
      request: new Request(config.origin),
      origin: config.origin,
      waitUntil: (p) => this.ctx.waitUntil(p),
    }
    const name = person?.display_name || person?.real_name || person?.name || user
    await postMessage(ctx, conversation, {
      user_id: actor.user.id,
      bot_id: actor.app!.bot_id,
      app_id: actor.app!.id,
      text: `*${name}*: ${heard.text}`,
      thread_ts: config.threadTs,
      metadata: JSON.stringify({
        event_type: "huddle_transcript",
        event_payload: {
          user,
          text: heard.text,
          ...(heard.language ? { language: heard.language } : {}),
          duration_ms: Math.round((utterance.length / 16_000) * 1000),
        },
      }),
    })
  }
}
