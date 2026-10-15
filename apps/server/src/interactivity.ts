import { Args } from "./api/args"
import { asApp } from "./api/as-app"
import type { Actor, Ctx } from "./api/context"
import { sign, verify } from "./api/crypto"
import { CampflareError } from "./api/errors"
import { randomSecret } from "./api/ids"
import { b64url, unb64url } from "./api/tickets"
import { requireMessage, postMessage } from "./db/messages"
import { stmt } from "./db/query"
import type { AppRow, ConversationRow, TeamRow, UserRow } from "./db/rows"
import { hubOf } from "./events"
import { postSigned } from "./request-url"
import type { Env } from "./env"
import {
  authorOf,
  content,
  deleteEphemeral,
  deleteMessage,
  editMessage,
  replaceEphemeral,
  sendEphemeral,
} from "./methods/chat"

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
  /** The message clicked; none for a slash command's (docs/commands-webhooks.md). */
  ts?: string
  /** Its thread, when it's a reply: where answers go. */
  threadTs?: string
  /** The message clicked was the clicker's ephemeral one: replacing or deleting it is theirs alone. */
  ephemeral?: boolean
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

/**
 * A trigger_id shaped like Slack's ("1234567890.1234567890.0123abcd…"). It's
 * random: the hub keeps whom it's for when the interaction carrying it is
 * sent (TeamHub.interact), and views.open or views.push spends it.
 */
export function triggerId(): string {
  const digits = [...crypto.getRandomValues(new Uint8Array(10))].map((b) => b % 10).join("")
  return `${Math.floor(Date.now() / 1000)}.${digits}.${randomSecret(16)}`
}

/** How an interaction reached the app, and what it answered (a view_submission's response_action). */
export interface Delivered {
  delivered: "socket" | "http"
  response?: unknown
}

/**
 * Sends an interaction payload to an app, as Slack does: over Socket Mode
 * when it has a link (an `interactive` envelope it must ack), else POSTed,
 * signed, to its Interactivity Request URL. Not retried: an app that doesn't
 * take it within 3 seconds is the person's error, `app_unreachable`. With
 * `acceptsResponse`, the ack's payload (or the POST's JSON answer) comes back.
 */
export async function deliverInteraction(
  ctx: Ctx<Actor>,
  app: AppRow,
  payload: Json,
  { acceptsResponse = false }: { acceptsResponse?: boolean } = {},
): Promise<Delivered> {
  const hub = hubOf(ctx, app.team_id)
  const trigger =
    typeof payload.trigger_id === "string" ? { id: payload.trigger_id, userId: ctx.auth.user.id } : undefined
  const socket = await hub.interact(app.id, payload, { trigger, acceptsResponse })
  if (socket.status === "acked") {
    return { delivered: "socket", ...(socket.response ? { response: JSON.parse(socket.response) as unknown } : {}) }
  }
  if (socket.status === "timeout") throw unreachable("its Socket Mode connection didn't acknowledge within 3 seconds")
  if (!app.interactivity_request_url) throw new CampflareError("interactivity_not_enabled")
  const res = await postSigned(
    app.interactivity_request_url,
    app.signing_secret,
    new URLSearchParams({ payload: JSON.stringify(payload) }).toString(),
    { contentType: "application/x-www-form-urlencoded" },
  )
  if (!res.ok) {
    throw unreachable(
      res.status === 0
        ? `no answer from its Interactivity Request URL (${res.reason})`
        : `its Interactivity Request URL answered ${res.status}`,
    )
  }
  if (!acceptsResponse || !res.body.trim()) return { delivered: "http" }
  try {
    return { delivered: "http", response: JSON.parse(res.body) as unknown }
  } catch {
    throw unreachable("its Interactivity Request URL answered with something other than JSON")
  }
}

const unreachable = (why: string) =>
  new CampflareError("app_unreachable", { response_metadata: { messages: [`[ERROR] the app didn't take it: ${why}`] } })

/** Who did it, as an interaction payload names them. */
export const interactor = (user: UserRow, teamId: string) => ({
  id: user.id,
  username: user.name,
  name: user.name,
  team_id: teamId,
})

type Json = Record<string, unknown>

const isJson = (v: unknown): v is Json => Boolean(v) && typeof v === "object" && !Array.isArray(v)

/** Select menus whose choice is one of the element's own options. */
const OPTION_SELECTS = new Set(["static_select", "overflow"])
/** Select menus whose choice is someone or somewhere in the workspace, and the field Slack names it by. */
export const ID_SELECTS: Record<string, "selected_user" | "selected_conversation" | "selected_channel"> = {
  users_select: "selected_user",
  conversations_select: "selected_conversation",
  channels_select: "selected_channel",
}

/** Element types a click can be on. */
const CLICKABLE = new Set(["button", "feedback_buttons", "icon_button", ...OPTION_SELECTS, ...Object.keys(ID_SELECTS)])

/** The interactive elements of a block: an actions block's elements, a section's accessory. */
export function elementsOf(block: Json): Json[] {
  if ((block.type === "actions" || block.type === "context_actions") && Array.isArray(block.elements)) {
    return block.elements.filter(isJson)
  }
  if (block.type === "section" && isJson(block.accessory)) return [block.accessory]
  return []
}

/** An element's options, those in option groups included. */
export function optionsOf(element: Json): Json[] {
  const flat = Array.isArray(element.options) ? element.options.filter(isJson) : []
  const grouped = Array.isArray(element.option_groups)
    ? element.option_groups.filter(isJson).flatMap((g) => (Array.isArray(g.options) ? g.options.filter(isJson) : []))
    : []
  return [...flat, ...grouped]
}

/** An option as Slack hands it back: its text and value, and its description when it has one. */
export const optionOut = (o: Json): Json => ({
  text: o.text,
  value: o.value,
  ...(o.description !== undefined ? { description: o.description } : {}),
})

/** What a click on an element is: the action, and the state it leaves, as block_actions carry them. */
export interface Clicked {
  action: Json
  /** state.values for the element, when it holds a choice (a select): `{ [block_id]: { [action_id]: … } }`. */
  state: Record<string, Record<string, Json>>
}

/**
 * The action a click makes, as Slack puts it in block_actions.actions[]: the
 * element found by its action_id (in the block given, or the first that has
 * it), described from the stored blocks, not from the clicker. A
 * feedback_buttons click names its button by `value`; a static_select or an
 * overflow its option by value; a users, conversations or channels select
 * the id chosen (checked by the caller: `ID_SELECTS`).
 */
export function actionOf(
  blocks: unknown,
  click: { blockId?: string; actionId: string; value?: string },
  actionTs: string,
): Clicked {
  if (!Array.isArray(blocks)) throw new CampflareError("action_not_found")
  for (const block of blocks as Json[]) {
    if (!isJson(block)) continue
    if (click.blockId !== undefined && block.block_id !== click.blockId) continue
    const element = elementsOf(block).find((e) => e.action_id === click.actionId)
    if (!element) continue
    const type = element.type as string
    if (!CLICKABLE.has(type)) throw new CampflareError("action_not_supported")
    const base = { type, block_id: block.block_id, action_id: element.action_id }
    const blockId = block.block_id as string
    const actionId = element.action_id as string
    const stateOf = (value: Json) => ({ [blockId]: { [actionId]: { type, ...value } } })
    if (type === "feedback_buttons") {
      const button = [element.positive_button, element.negative_button].find(
        (b) => isJson(b) && b.value === click.value,
      ) as Json | undefined
      if (!button || click.value === undefined) throw new CampflareError("invalid_value")
      return { action: { ...base, text: button.text, value: button.value, action_ts: actionTs }, state: {} }
    }
    if (OPTION_SELECTS.has(type)) {
      const option = optionsOf(element).find((o) => o.value === click.value)
      if (!option || click.value === undefined) throw new CampflareError("invalid_value")
      const selected = { selected_option: optionOut(option) }
      return {
        action: {
          ...base,
          ...selected,
          ...(element.placeholder !== undefined ? { placeholder: element.placeholder } : {}),
          action_ts: actionTs,
        },
        state: type === "overflow" ? {} : stateOf(selected),
      }
    }
    const field = ID_SELECTS[type]
    if (field) {
      if (!click.value) throw new CampflareError("invalid_value")
      const initial = field.replace("selected_", "initial_")
      return {
        action: {
          ...base,
          [field]: click.value,
          ...(element[initial] !== undefined ? { [initial]: element[initial] } : {}),
          action_ts: actionTs,
        },
        state: stateOf({ [field]: click.value }),
      }
    }
    if (click.value !== undefined && click.value !== (element.value ?? "")) throw new CampflareError("invalid_value")
    return {
      action: {
        ...base,
        ...(type === "icon_button" ? { icon: element.icon } : {}),
        text: element.text,
        ...(element.value !== undefined ? { value: element.value } : {}),
        ...(element.style !== undefined ? { style: element.style } : {}),
        ...(element.url !== undefined ? { url: element.url } : {}),
        action_ts: actionTs,
      },
      state: {},
    }
  }
  throw new CampflareError("action_not_found")
}

/** Someone or somewhere a person chose in a select menu: what their client let them pick from. */
export interface Choice {
  field: "selected_user" | "selected_conversation" | "selected_channel"
  id: string
}

/**
 * Checks, in one round trip, that each choice was on offer: a person in the
 * workspace, a conversation the chooser can read, a public channel. Else
 * `invalid_value`, naming the first that wasn't.
 */
export async function requireChoices(ctx: Ctx<Actor>, choices: Choice[]): Promise<void> {
  if (choices.length === 0) return
  const db = ctx.env.DB
  const team = ctx.auth.team.id
  const users = choices.filter((c) => c.field === "selected_user").map((c) => c.id)
  const places = choices.filter((c) => c.field !== "selected_user").map((c) => c.id)
  const [u, c] = await db.batch([
    stmt(
      db,
      "SELECT id FROM users WHERE team_id = ? AND deleted = 0 AND id IN (SELECT value FROM json_each(?))",
      team,
      JSON.stringify(users),
    ),
    stmt(
      db,
      `SELECT c.id, c.kind, c.is_private,
         EXISTS (SELECT 1 FROM members m WHERE m.conversation_id = c.id AND m.user_id = ?) AS member
       FROM conversations c WHERE c.team_id = ? AND c.id IN (SELECT value FROM json_each(?))`,
      ctx.auth.user.id,
      team,
      JSON.stringify(places),
    ),
  ])
  const people = new Set((u!.results as { id: string }[]).map((r) => r.id))
  const found = new Map(
    (c!.results as (Pick<ConversationRow, "id" | "kind" | "is_private"> & { member: number })[]).map((r) => [r.id, r]),
  )
  for (const choice of choices) {
    const place = found.get(choice.id)
    const publicChannel = place?.kind === "channel" && !place.is_private
    const ok =
      choice.field === "selected_user"
        ? people.has(choice.id)
        : choice.field === "selected_channel"
          ? publicChannel
          : Boolean(place && (place.member || publicChannel))
    if (!ok) {
      throw new CampflareError("invalid_value", {
        response_metadata: { messages: [`[ERROR] ${choice.field}: no ${choice.id} to choose`] },
      })
    }
  }
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
  const hub = hubOf({ env }, claims.teamId)
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
    const ctx = asApp(env, request, waitUntil, { team, app, bot }, args)
    const threadTs = args.ts("thread_ts") ?? claims.threadTs
    const ts = claims.ts
    // The clicked message was ephemeral: it's the clicker's alone to change.
    const original = claims.ephemeral || !ts ? undefined : () => requireMessage(ctx, c.id, ts)
    if (args.bool("delete_original")) {
      // A slash command's response_url has no message of its own to delete.
      if (!ts) throw new CampflareError("message_not_found")
      if (original) await deleteMessage(ctx, c, await original())
      else deleteEphemeral(ctx, c, claims.userId, ts)
    } else if (args.bool("replace_original") && ts) {
      if (c.is_archived) throw new CampflareError("is_archived")
      if (original) await editMessage(ctx, c, await original(), { quiet: true })
      else replaceEphemeral(ctx, c, claims.userId, ts, claims.threadTs)
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
