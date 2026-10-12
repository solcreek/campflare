import type { TeamHub } from "./hub"

export interface Env {
  DB: D1Database
  FILES: R2Bucket
  HUB: DurableObjectNamespace<TeamHub>
  SIGNING_KEY: string
  BOOTSTRAP_SECRET?: string
  /** Huddles (experiment): the Realtime SFU app, and an optional TURN key. */
  REALTIME_APP_ID?: string
  REALTIME_APP_SECRET?: string
  REALTIME_TURN_KEY_ID?: string
  REALTIME_TURN_KEY_TOKEN?: string
}
