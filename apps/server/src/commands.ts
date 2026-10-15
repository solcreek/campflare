import { Args } from "./api/args"
import { asApp } from "./api/as-app"
import type { Actor, Ctx } from "./api/context"
import { CampflareError } from "./api/errors"
import { postMessage } from "./db/messages"
import type { AppRow, ConversationRow, UserRow } from "./db/rows"
import { channelName, issueResponseUrl, triggerId } from "./interactivity"
import { authorOf, content, sendEphemeral } from "./methods/chat"
import { postSigned } from "./request-url"

// Slash commands (docs/commands-webhooks.md): a person types `/deploy staging`,
// the app that registered /deploy gets it as Slack sends it (a Socket Mode
// `slash_commands` envelope, else a signed form POST to the command's Request
// URL), and its immediate answer is shown to the person or posted in the
// conversation.

/**
 * A command's name: a slash, then up to 31 lower-case letters (any script),
 * digits, `-` or `_`. Slack's are lower case and have no spaces.
 */
export const COMMAND_NAME = /^\/[\p{Ll}\p{Lo}\p{N}_-]{1,31}$/u

export interface CommandRow {
  team_id: string
  name: string
  app_id: string
  description: string
  usage_hint: string
  url: string | null
  created: number
}

/**
 * A command as everyone sees it (campflare.commands.list): no Request URL,
 * which may be an internal endpoint or carry a secret in its query.
 */
export const commandJson = (row: Omit<CommandRow, "team_id" | "url" | "created"> & { app_name?: string }) => ({
  command: row.name,
  description: row.description,
  usage_hint: row.usage_hint,
  app_id: row.app_id,
  ...(row.app_name !== undefined ? { app_name: row.app_name } : {}),
})

/** A command as its app's installer or an admin sees it (campflare.apps.info, .setCommands): with its URL. */
export const commandSettings = (row: Omit<CommandRow, "team_id" | "created">) => ({ ...commandJson(row), url: row.url })

/** What the app answered at once: a message for the person, or for the conversation (`in_channel`). */
type Answer = Record<string, unknown>

const unreachable = (why: string) =>
  new CampflareError("app_unreachable", { response_metadata: { messages: [`[ERROR] the app didn't take it: ${why}`] } })

const dispatchFailed = (why: string) =>
  new CampflareError("dispatch_failed", { response_metadata: { messages: [`[ERROR] ${why}`] } })

/**
 * Hands a command to its app: over a Socket Mode link (`slash_commands`,
 * acked within 3 seconds, the ack's payload the answer), else POSTed as a
 * signed form to the command's Request URL (the body the answer: JSON, or
 * plain text for the person). Its trigger_id is kept for a views.open first,
 * whichever way it goes.
 */
async function deliver(
  ctx: Ctx<Actor>,
  app: AppRow,
  command: CommandRow,
  payload: Record<string, string>,
): Promise<{ delivered: "socket" | "http"; answer?: Answer }> {
  const hub = ctx.env.HUB.get(ctx.env.HUB.idFromName(app.team_id))
  const socket = await hub.interact(app.id, payload, {
    trigger: { id: payload.trigger_id!, userId: ctx.auth.user.id },
    acceptsResponse: true,
    type: "slash_commands",
  })
  if (socket.status === "acked") return { delivered: "socket", answer: answerOf(socket.response) }
  if (socket.status === "timeout") throw unreachable("its Socket Mode connection didn't acknowledge within 3 seconds")
  if (!command.url) throw unreachable("it has no Socket Mode connection and the command has no Request URL")
  const res = await postSigned(command.url, app.signing_secret, new URLSearchParams(payload).toString(), {
    contentType: "application/x-www-form-urlencoded",
  })
  if (res.status === 0) throw unreachable(`no answer from the command's Request URL (${res.reason})`)
  if (!res.ok) throw dispatchFailed(`the command's Request URL answered ${res.status}`)
  const body = res.body.trim()
  if (!body) return { delivered: "http" }
  if (!body.startsWith("{")) return { delivered: "http", answer: { text: body } }
  try {
    return { delivered: "http", answer: answerOf(body) }
  } catch {
    throw dispatchFailed("the command's Request URL answered with broken JSON")
  }
}

/** An answer from its JSON (an ack's payload, a response body): an object, or a string for the person. */
function answerOf(json: string | undefined): Answer | undefined {
  if (json === undefined) return undefined
  const value = JSON.parse(json) as unknown
  if (typeof value === "string") return value ? { text: value } : undefined
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Answer
  return undefined
}

export interface Invoked {
  delivered: "socket" | "http"
  /** What the app answered at once, as it was shown: to the person (ephemeral) or posted (in_channel). */
  response?: { response_type: "ephemeral" | "in_channel"; text: string; blocks?: unknown; ts: string }
}

/**
 * Runs a command in a conversation the person can post in: delivers it, then
 * shows the app's immediate answer as its bot, to the person alone or (with
 * `response_type: in_channel`) to the conversation.
 */
export async function invokeCommand(
  ctx: Ctx<Actor>,
  c: ConversationRow,
  found: { command: CommandRow; app: AppRow; bot: UserRow },
  text: string,
): Promise<Invoked> {
  const { command, app, bot } = found
  const user = ctx.auth.user
  const team = ctx.auth.team
  const payload: Record<string, string> = {
    // Slack's verification token is deprecated: requests are signed instead.
    token: "",
    team_id: team.id,
    team_domain: team.domain,
    channel_id: c.id,
    channel_name: channelName(c),
    user_id: user.id,
    user_name: user.name,
    command: command.name,
    text,
    api_app_id: app.id,
    is_enterprise_install: "false",
    response_url: await issueResponseUrl(ctx.env.SIGNING_KEY, ctx.origin, {
      teamId: team.id,
      channelId: c.id,
      appId: app.id,
      userId: user.id,
    }),
    trigger_id: triggerId(),
  }
  const { delivered, answer } = await deliver(ctx, app, command, payload)
  if (!answer) return { delivered }
  const asBot = asApp(ctx.env, ctx.request, ctx.waitUntil, { team, app, bot }, new Args(answer), ctx.origin)
  const shown = content(asBot, false)
  if (!shown.text && !shown.blocks && !shown.attachments) return { delivered }
  const blocks = shown.blocks ? (JSON.parse(shown.blocks) as unknown) : undefined
  if (answer.response_type === "in_channel") {
    if (c.is_archived) throw new CampflareError("is_archived")
    const { row } = await postMessage(asBot, c, { ...authorOf(asBot), ...shown })
    return { delivered, response: { response_type: "in_channel", text: row.text, blocks, ts: row.ts } }
  }
  const ts = sendEphemeral(asBot, c, user.id)
  return { delivered, response: { response_type: "ephemeral", text: shown.text, blocks, ts } }
}
