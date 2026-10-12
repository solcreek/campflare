import type { HuddleScribe } from "./huddle/scribe"
import type { TeamHub } from "./hub"

export interface Env {
  DB: D1Database
  FILES: R2Bucket
  HUB: DurableObjectNamespace<TeamHub>
  SCRIBE: DurableObjectNamespace<HuddleScribe>
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
}
