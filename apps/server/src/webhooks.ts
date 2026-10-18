import { Args } from "./api/args"
import { asApp } from "./api/as-app"
import { sha256Hex } from "./api/crypto"
import { CampflareError } from "./api/errors"
import { nowSeconds } from "./api/ids"
import { postMessage } from "./db/messages"
import { joinedRow, stmt } from "./db/query"
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
    // The webhook, its tokens now, and all it posts as and to: one row, one round trip.
    const found = await joinedRow<{
      hook: WebhookRow & { tokens: number }
      app: AppRow
      team: TeamRow
      bot: UserRow
      conversation: ConversationRow
      member: { bot_member: number }
    }>(
      env.DB,
      `SELECT 1 AS "#hook", w.*, ${TOKENS} AS tokens,
         (a.id IS NOT NULL) AS "#app", a.*,
         (t.id IS NOT NULL) AS "#team", t.*,
         (u.id IS NOT NULL) AS "#bot", u.*,
         (c.id IS NOT NULL) AS "#conversation", c.*,
         1 AS "#member", (m.user_id IS NOT NULL) AS bot_member
       FROM webhooks w
         LEFT JOIN apps a ON a.id = w.app_id
         LEFT JOIN teams t ON t.id = w.team_id
         LEFT JOIN users u ON u.id = a.bot_user_id
         LEFT JOIN conversations c ON c.id = w.channel_id AND c.team_id = w.team_id
         LEFT JOIN members m ON m.conversation_id = c.id AND m.user_id = u.id
       WHERE w.hash = ?2 AND w.revoked IS NULL`,
      now,
      hash,
    )
    const { hook, app, team, bot, conversation: c, member } = found ?? {}
    if (!hook || !app || !team || !bot) throw new CampflareError("no_service")
    // A deactivated bot posts nothing, as on Slack when an admin restricts an app.
    if (bot.deleted) throw new CampflareError("action_prohibited")
    if (!c) throw new CampflareError("channel_not_found")
    if (c.is_archived) throw new CampflareError("channel_is_archived")
    // As chat.postMessage lets the bot (chat:write.public): any public channel, else one it's in.
    const isPublic = c.kind === "channel" && !c.is_private
    if (!isPublic && !member?.bot_member) throw new CampflareError("channel_not_found")
    const ctx = asApp(env, request, waitUntil, { team, app, bot }, new Args(payload))
    const message = { ...authorOf(ctx), ...content(ctx), thread_ts: ctx.args.ts("thread_ts") ?? null }
    // Only a post that passed every check spends a token.
    if (hook.tokens < 1) {
      const wait = Math.max(1, Math.ceil((1 - hook.tokens) / WEBHOOK_PER_SECOND))
      return answer(429, "rate_limited", { "retry-after": String(wait) })
    }
    // The token is spent in the post's own batch: no post, no spend. Two posts at once may both see the
    // last token and both spend it; the bucket goes below zero and the debt is waited out.
    await postMessage(ctx, c, message, [
      stmt(
        env.DB,
        `UPDATE webhooks SET bucket = ${TOKENS} - 1, bucket_at = ?1, last_used = ?3 WHERE hash = ?2`,
        now,
        hash,
        nowSeconds(),
      ),
    ])
    return answer(200, "ok")
  } catch (error) {
    if (error instanceof CampflareError) return answer(STATUS[error.code] ?? 400, error.code)
    console.error("incoming webhook failed", error)
    return answer(500, "internal_error")
  }
}
