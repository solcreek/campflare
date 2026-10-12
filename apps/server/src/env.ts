import type { TeamHub } from "./hub"

export interface Env {
  DB: D1Database
  FILES: R2Bucket
  HUB: DurableObjectNamespace<TeamHub>
  SIGNING_KEY: string
  BOOTSTRAP_SECRET?: string
}
