import type { HuddleScribe } from "./huddle/scribe"
import type { TeamHub } from "./hub"
import type { Scheduler } from "./scheduler"

export interface Env {
  DB: D1Database
  FILES: R2Bucket
  /** Cloudflare Images, which makes thumbnails. Optional: without it, files have no thumb_*. */
  IMAGES?: ImagesBinding
  HUB: DurableObjectNamespace<TeamHub>
  SCRIBE: DurableObjectNamespace<HuddleScribe>
  /** Fires scheduled messages and reminders: one per workspace (docs/scheduling.md). */
  SCHEDULER: DurableObjectNamespace<Scheduler>
  SIGNING_KEY: string
  BOOTSTRAP_SECRET?: string
  /** Huddles (off without them): the Realtime SFU app, and an optional TURN key. */
  REALTIME_APP_ID?: string
  REALTIME_APP_SECRET?: string
  REALTIME_TURN_KEY_ID?: string
  REALTIME_TURN_KEY_TOKEN?: string
  /** Huddle transcription: Workers AI over REST, with a token scoped to Workers AI. */
  CF_ACCOUNT_ID?: string
  WORKERS_AI_TOKEN?: string
  /** The public origin the SFU connects back to for transcription (a tunnel in development). Defaults to the request's. */
  HUDDLE_PUBLIC_URL?: string
  /**
   * Where the app (apps/web) is served, e.g. https://app.example.com/: permalinks
   * (/archives/...) redirect there, to the message's hash route. pnpm dev:all sets it.
   */
  APP_URL?: string
  /**
   * "true" (or "1"): permalinks answer a page offering the desktop app (a
   * campflare:// link) and the web app, instead of redirecting to APP_URL.
   */
  OFFER_DESKTOP_APP?: string
}
