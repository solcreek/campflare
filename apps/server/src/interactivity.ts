import { Args } from "./api/args"
import { DEFAULT_BOT_SCOPES } from "./api/auth"
import type { Actor, Ctx } from "./api/context"
import { sign, verify } from "./api/crypto"
import { CampflareError } from "./api/errors"
import { randomSecret } from "./api/ids"
import { publicOrigin } from "./api/origin"
import { b64url, unb64url } from "./api/tickets"
import { requireMessage, postMessage } from "./db/messages"
import { stmt } from "./db/query"
import type { AppRow, ConversationRow, TeamRow, UserRow } from "./db/rows"
import type { Env } from "./env"
import { authorOf, content, deleteMessage, editMessage, sendEphemeral } from "./methods/chat"

// Interactivity: a click on a button in an app's message reaches the app as a
// block_actions payload (methods/blocks.ts), with a response_url the app may
// POST to a few times, for a while, to answer: replace or delete the message,
// or say something to the clicker (ephemeral) or to everyone (in_channel).

/** A response_url works for 30 minutes, and 5 times, as Slack's do. */
export const RESPONSE_URL_TTL_MS = 30 * 60 * 1000
export const RESPONSE_URL_MAX_USES = 5

/** What a response_url stands for, signed into it so it needs no table to look up. */
export interface ResponseUrlClaims {
  /** Sets these apart from other signed values (WebSocket tickets). */
  purpose: "response_url"
  teamId: string
  channelId: string
  /** The message clicked. */
  ts: string
  /** Its thread, when it's a reply: where answers go. */
  threadTs?: string
  appId: string
  /** Who clicked: ephemeral answers go to them. */
  userId: string
  nonce: string
  expires: number
}

export type ResponseUrlTarget = Omit<ResponseUrlClaims, "purpose" | "nonce" | "expires">

/** A new response_url: `<origin>/actions/<signed claims>`. */
export async function issueResponseUrl(key: string, origin: string, target: ResponseUrlTarget): Promise<string> {
  const claims: ResponseUrlClaims = {
    purpose: "response_url",
    ...target,
    nonce: randomSecret(12),
    expires: Date.now() + RESPONSE_URL_TTL_MS,
  }
  return `${origin}/actions/${await sign(key, b64url(JSON.stringify(claims)))}`
}

/** The claims of a response_url's last path segment, or undefined when forged or expired. */
export async function readResponseUrl(key: string, token: string): Promise<ResponseUrlClaims | undefined> {
  const payload = await verify(key, token)
  if (!payload) return undefined
  try {
    const claims = JSON.parse(unb64url(payload)) as ResponseUrlClaims
    return claims.purpose === "response_url" && claims.expires > Date.now() ? claims : undefined
  } catch {
    return undefined
  }
}

/** A trigger_id shaped like Slack's ("1234567890.1234567890.0123abcd…"). Nothing accepts one yet: no views.open. */
export function triggerId(): string {
  const digits = [...crypto.getRandomValues(new Uint8Array(10))].map((b) => b % 10).join("")
  return `${Math.floor(Date.now() / 1000)}.${digits}.${randomSecret(16)}`
}

type Json = Record<string, unknown>

/** Element types a click can be on, and what the clicker must say for each. */
const CLICKABLE = new Set(["button", "feedback_buttons"])

/**
 * The action a click makes, as Slack puts it in block_actions.actions[]: the
 * element found by its action_id (in the block given, or the first that has
 * it), described from the stored message, not from the clicker. A
 * feedback_buttons click names its button by `value`.
 */
export function actionOf(
  blocks: unknown,
  click: { blockId?: string; actionId: string; value?: string },
  actionTs: string,
): Json {
  if (!Array.isArray(blocks)) throw new CampflareError("action_not_found")
  for (const block of blocks as Json[]) {
    if (!block || typeof block !== "object") continue
    if (click.blockId !== undefined && block.block_id !== click.blockId) continue
    if (block.type !== "actions" && block.type !== "context_actions") continue
    if (!Array.isArray(block.elements)) continue
    const element = (block.elements as Json[]).find((e) => e && e.action_id === click.actionId)
    if (!element) continue
    if (!CLICKABLE.has(element.type as string)) throw new CampflareError("action_not_supported")
    const base = { type: element.type, block_id: block.block_id, action_id: element.action_id }
    if (element.type === "feedback_buttons") {
      const button = [element.positive_button, element.negative_button].find(
        (b) => b && typeof b === "object" && (b as Json).value === click.value,
      ) as Json | undefined
      if (!button || click.value === undefined) throw new CampflareError("invalid_value")
      return { ...base, text: button.text, value: button.value, action_ts: actionTs }
    }
    if (click.value !== undefined && click.value !== (element.value ?? "")) throw new CampflareError("invalid_value")
    return {
      ...base,
      text: element.text,
      ...(element.value !== undefined ? { value: element.value } : {}),
      ...(element.style !== undefined ? { style: element.style } : {}),
      ...(element.url !== undefined ? { url: element.url } : {}),
      action_ts: actionTs,
    }
  }
  throw new CampflareError("action_not_found")
}

/** How Slack names a conversation in an interaction payload: DMs are "directmessage". */
export function channelName(c: Pick<ConversationRow, "kind" | "name">): string {
  return c.kind === "im" ? "directmessage" : c.name
}

const answer = (status: number, body: Json) => Response.json(body, { status })

/**
 * POST <response_url>: an app's answer to a click, as JSON (or a form with
 * `payload`). `delete_original`, `replace_original` (with text/blocks), or a
 * new message: `response_type` "in_channel" for everyone, else ephemeral to
 * the clicker. In the clicked message's thread, unless `thread_ts` says
 * otherwise. Acts as the app's bot.
 */
export async function handleResponseUrl(
  env: Env,
  request: Request,
  token: string,
  waitUntil: (p: Promise<unknown>) => void,
): Promise<Response> {
  const claims = await readResponseUrl(env.SIGNING_KEY, token)
  if (!claims) return answer(404, { ok: false, error: "expired_url" })
  const hub = env.HUB.get(env.HUB.idFromName(claims.teamId))
  if (!(await hub.useResponseUrl(claims.nonce, claims.expires, RESPONSE_URL_MAX_USES))) {
    return answer(404, { ok: false, error: "used_url" })
  }
  try {
    let args = await Args.from(request)
    const wrapped = args.str("payload")
    if (wrapped !== undefined) {
      const parsed = args.json<unknown>("payload", "invalid_payload")
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new CampflareError("invalid_payload")
      args = new Args(parsed as Json)
    }
    const [apps, teams, users, conversations] = await env.DB.batch([
      stmt(env.DB, "SELECT * FROM apps WHERE id = ? AND team_id = ?", claims.appId, claims.teamId),
      stmt(env.DB, "SELECT * FROM teams WHERE id = ?", claims.teamId),
      stmt(
        env.DB,
        "SELECT * FROM users WHERE id = (SELECT bot_user_id FROM apps WHERE id = ?) AND deleted = 0",
        claims.appId,
      ),
      stmt(env.DB, "SELECT * FROM conversations WHERE id = ? AND team_id = ?", claims.channelId, claims.teamId),
    ])
    const app = apps!.results[0] as AppRow | undefined
    const team = teams!.results[0] as TeamRow | undefined
    const bot = users!.results[0] as UserRow | undefined
    const c = conversations!.results[0] as ConversationRow | undefined
    if (!app || !team || !bot || !c) return answer(404, { ok: false, error: "expired_url" })
    const ctx: Ctx<Actor> = {
      env,
      args,
      auth: { kind: "bot", team, user: bot, app, scopes: DEFAULT_BOT_SCOPES },
      request,
      origin: publicOrigin(request),
      waitUntil,
    }
    const threadTs = args.ts("thread_ts") ?? claims.threadTs
    if (args.bool("delete_original")) {
      await deleteMessage(ctx, c, await requireMessage(ctx, c.id, claims.ts))
    } else if (args.bool("replace_original")) {
      if (c.is_archived) throw new CampflareError("is_archived")
      await editMessage(ctx, c, await requireMessage(ctx, c.id, claims.ts), { quiet: true })
    } else if (args.str("response_type") === "in_channel") {
      if (c.is_archived) throw new CampflareError("is_archived")
      await postMessage(ctx, c, { ...authorOf(ctx), ...content(ctx), thread_ts: threadTs ?? null })
    } else {
      sendEphemeral(ctx, c, claims.userId, threadTs)
    }
    return answer(200, { ok: true })
  } catch (error) {
    if (error instanceof CampflareError) return answer(400, { ok: false, error: error.code, ...error.extra })
    console.error("response_url failed", error)
    return answer(500, { ok: false, error: "internal_error" })
  }
}
