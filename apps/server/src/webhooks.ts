import { Args } from "./api/args"
import { asApp } from "./api/as-app"
import { sha256Hex } from "./api/crypto"
import { CampflareError } from "./api/errors"
import { nowSeconds } from "./api/ids"
import { postMessage } from "./db/messages"
import { stmt } from "./db/query"
import type { AppRow, ConversationRow, TeamRow, UserRow } from "./db/rows"
import type { Env } from "./env"
import { authorOf, content } from "./methods/chat"

// Incoming webhooks (docs/commands-webhooks.md): a POST to
// <origin>/services/<secret> posts Slack's incoming-webhook body in the
// webhook's conversation as its app's bot, and answers as Slack does: the
// plain text `ok`, or an error code with Slack's status.

/** Each webhook may post once a second, after a burst of this many. */
export const WEBHOOK_BURST = 10
export const WEBHOOK_PER_SECOND = 1

export interface WebhookRow {
  id: string
  team_id: string
  app_id: string
  channel_id: string
  hash: string
  label: string
  created_by: string
  created: number
  revoked: number | null
  last_used: number | null
  bucket: number
  bucket_at: number
}

/** Slack's status for each error a webhook answers. */
const STATUS: Record<string, number> = {
  invalid_payload: 400,
  no_text: 400,
  invalid_blocks: 400,
  invalid_attachments: 400,
  msg_too_long: 400,
  thread_not_found: 400,
  invalid_arguments: 400,
  no_service: 404,
  channel_not_found: 404,
  channel_is_archived: 410,
  action_prohibited: 403,
  rate_limited: 429,
}

const answer = (status: number, body: string, headers: Record<string, string> = {}) =>
  new Response(body, { status, headers: { "content-type": "text/html; charset=utf-8", ...headers } })

/** The body as Slack takes it: JSON (whatever the content type says), or a form with `payload=<json>`. */
async function payloadOf(request: Request): Promise<Record<string, unknown>> {
  let text: string
  const type = request.headers.get("content-type") ?? ""
  if (type.includes("application/x-www-form-urlencoded") || type.includes("multipart/form-data")) {
    const payload = (await request.formData().catch(() => undefined))?.get("payload")
    if (typeof payload !== "string") throw new CampflareError("invalid_payload")
    text = payload
  } else {
    text = await request.text()
  }
  try {
    const value = JSON.parse(text) as unknown
    if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>
  } catch {
    // below
  }
  throw new CampflareError("invalid_payload")
}

/** The token a POST takes now, refilled since bucket_at: SQL over the row's columns and ?1 (now, ms). */
const TOKENS = `MIN(${WEBHOOK_BURST}, bucket + (?1 - bucket_at) * ${WEBHOOK_PER_SECOND} / 1000.0)`

/** POST /services/<secret>. */
export async function handleWebhook(
  env: Env,
  request: Request,
  secret: string,
  waitUntil: (p: Promise<unknown>) => void,
): Promise<Response> {
  try {
    const payload = await payloadOf(request)
    const hash = await sha256Hex(secret)
    const now = Date.now()
    const db = env.DB
    const live = "SELECT %s FROM webhooks WHERE hash = ?2 AND revoked IS NULL"
    // The token taken (when there is one), the webhook, and all it posts as and to: one round trip.
    const [taken, hooks, apps, teams, bots, conversations, members] = await db.batch([
      stmt(
        db,
        `UPDATE webhooks SET bucket = ${TOKENS} - 1, bucket_at = ?1, last_used = ?3
         WHERE hash = ?2 AND revoked IS NULL AND ${TOKENS} >= 1 RETURNING id`,
        now,
        hash,
        nowSeconds(),
      ),
      stmt(db, `SELECT *, ${TOKENS} AS tokens FROM webhooks WHERE hash = ?2 AND revoked IS NULL`, now, hash),
      stmt(db, `SELECT * FROM apps WHERE id = (${live.replace("%s", "app_id")})`, now, hash),
      stmt(db, `SELECT * FROM teams WHERE id = (${live.replace("%s", "team_id")})`, now, hash),
      stmt(
        db,
        `SELECT * FROM users WHERE id = (SELECT bot_user_id FROM apps WHERE id = (${live.replace("%s", "app_id")}))`,
        now,
        hash,
      ),
      stmt(db, `SELECT * FROM conversations WHERE id = (${live.replace("%s", "channel_id")})`, now, hash),
      stmt(
        db,
        `SELECT 1 FROM members WHERE conversation_id = (${live.replace("%s", "channel_id")})
           AND user_id = (SELECT bot_user_id FROM apps WHERE id = (${live.replace("%s", "app_id")}))`,
        now,
        hash,
      ),
    ])
    const hook = hooks!.results[0] as (WebhookRow & { tokens: number }) | undefined
    const app = apps!.results[0] as AppRow | undefined
    const team = teams!.results[0] as TeamRow | undefined
    const bot = bots!.results[0] as UserRow | undefined
    const c = conversations!.results[0] as ConversationRow | undefined
    if (!hook || !app || !team || !bot) throw new CampflareError("no_service")
    if (!taken!.results.length) {
      const wait = Math.max(1, Math.ceil((1 - hook.tokens) / WEBHOOK_PER_SECOND))
      return answer(429, "rate_limited", { "retry-after": String(wait) })
    }
    // A deactivated bot posts nothing, as on Slack when an admin restricts an app.
    if (bot.deleted) throw new CampflareError("action_prohibited")
    if (!c) throw new CampflareError("channel_not_found")
    if (c.is_archived) throw new CampflareError("channel_is_archived")
    // As chat.postMessage lets the bot (chat:write.public): any public channel, else one it's in.
    const isPublic = c.kind === "channel" && !c.is_private
    if (!isPublic && !members!.results.length) throw new CampflareError("channel_not_found")
    const ctx = asApp(env, request, waitUntil, { team, app, bot }, new Args(payload))
    await postMessage(ctx, c, {
      ...authorOf(ctx),
      ...content(ctx),
      thread_ts: ctx.args.ts("thread_ts") ?? null,
    })
    return answer(200, "ok")
  } catch (error) {
    if (error instanceof CampflareError) return answer(STATUS[error.code] ?? 400, error.code)
    console.error("incoming webhook failed", error)
    return answer(500, "internal_error")
  }
}
