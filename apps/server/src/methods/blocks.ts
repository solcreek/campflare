import { getConversation, requireNotArchived, requireReadable } from "../db/conversations"
import { reactionsStatement } from "../db/messages"
import { first, stmt } from "../db/query"
import type { AppRow, ConversationRow, MessageRow, ReactionRow } from "../db/rows"
import { method, type Actor, type Ctx } from "../api/context"
import { CampflareError } from "../api/errors"
import { loadExtras, messageJson } from "../api/shapes"
import {
  actionOf,
  channelName,
  deliverInteraction,
  ID_SELECTS,
  interactor,
  issueResponseUrl,
  requireChoices,
  triggerId,
  type Choice,
  type Clicked,
} from "../interactivity"
import { findView, formState, givenValues } from "../views"

/**
 * A person clicks a button, or chooses in a select menu, in an app's message
 * or in a view the app opened for them (Campflare's own method; a Slack
 * client uses an internal one). `channel` and `ts` name the message, or
 * `view_id` the view; then `action_id`, and `block_id` when several blocks
 * share the action_id. `value` names a feedback button, a static_select's or
 * an overflow's option, or the person or conversation chosen in a users,
 * conversations or channels select. In a view, `values` may say what its
 * inputs hold now, as campflare.views.submit takes them. The app gets
 * block_actions, as Slack sends it (see deliverInteraction).
 */
method("campflare.blocks.action", "user", async (ctx) => {
  const delivered = ctx.args.str("view_id") ? await inView(ctx) : await inMessage(ctx)
  return { delivered: delivered.delivered }
})

const actionTs = () => `${(Date.now() / 1000).toFixed(6)}`

/** The element clicked, found in `blocks`, with the people and conversations it chose. */
function clickOn(ctx: Ctx<Actor>, blocks: unknown): Clicked & { choices: Choice[] } {
  const clicked = actionOf(
    blocks,
    { blockId: ctx.args.str("block_id"), actionId: ctx.args.req("action_id"), value: ctx.args.str("value") },
    actionTs(),
  )
  const field = ID_SELECTS[clicked.action.type as string]
  return { ...clicked, choices: field ? [{ field, id: clicked.action[field] as string }] : [] }
}

async function inMessage(ctx: Ctx<Actor>) {
  const c = await getConversation(ctx, ctx.args.req("channel", "channel_not_found"))
  // As on Slack, anyone who can read the conversation may click, not only its members.
  await requireReadable(ctx, c)
  requireNotArchived(c)
  const ts = ctx.args.ts("ts")
  if (!ts) throw new CampflareError("message_not_found")
  const db = ctx.env.DB
  const [messages, apps, reactions] = await db.batch([
    stmt(db, "SELECT * FROM messages WHERE channel_id = ? AND ts = ? AND deleted = 0", c.id, ts),
    stmt(
      db,
      "SELECT * FROM apps WHERE id = (SELECT app_id FROM messages WHERE channel_id = ? AND ts = ?) AND team_id = ?",
      c.id,
      ts,
      c.team_id,
    ),
    reactionsStatement(db, c.id, ts),
  ])
  const message = messages!.results[0] as MessageRow | undefined
  if (!message) return inEphemeral(ctx, c, ts)
  const app = apps!.results[0] as AppRow | undefined
  // Only an app's messages answer clicks: a person's blocks have nobody to go to.
  if (!app) throw new CampflareError("not_interactive")
  const { action, state, choices } = clickOn(ctx, message.blocks ? JSON.parse(message.blocks) : undefined)
  await requireChoices(ctx, choices)
  const user = ctx.auth.user
  const reply = message.thread_ts && message.thread_ts !== message.ts ? message.thread_ts : undefined
  const extras = await loadExtras(ctx.env, [message], reactions!.results as ReactionRow[])
  const payload = {
    type: "block_actions",
    user: interactor(user, c.team_id),
    api_app_id: app.id,
    token: "",
    container: {
      type: "message",
      message_ts: message.ts,
      channel_id: c.id,
      is_ephemeral: false,
      ...(reply ? { thread_ts: reply } : {}),
    },
    trigger_id: triggerId(),
    team: { id: ctx.auth.team.id, domain: ctx.auth.team.domain },
    enterprise: null,
    is_enterprise_install: false,
    channel: { id: c.id, name: channelName(c) },
    message: messageJson(message, extras, ctx.origin),
    state: { values: state },
    response_url: await issueResponseUrl(ctx.env.SIGNING_KEY, ctx.origin, {
      teamId: c.team_id,
      channelId: c.id,
      ts: message.ts,
      ...(reply ? { threadTs: reply } : {}),
      appId: app.id,
      userId: user.id,
    }),
    actions: [action],
  }
  return deliverInteraction(ctx, app, payload)
}

/**
 * A click on an app's ephemeral message to the clicker, which the hub keeps
 * for a day (it isn't in D1): block_actions without the message, as Slack
 * sends it, and a response_url that replaces or deletes it for them alone.
 */
async function inEphemeral(ctx: Ctx<Actor>, c: ConversationRow, ts: string) {
  const user = ctx.auth.user
  const kept = await ctx.env.HUB.get(ctx.env.HUB.idFromName(c.team_id)).ephemeral(c.id, ts, user.id)
  if (!kept) throw new CampflareError("message_not_found")
  const message = JSON.parse(kept) as { app_id?: string; blocks?: unknown; thread_ts?: string }
  const app = await first<AppRow>(
    ctx.env.DB,
    "SELECT * FROM apps WHERE id = ? AND team_id = ?",
    message.app_id ?? "",
    c.team_id,
  )
  if (!app) throw new CampflareError("not_interactive")
  const { action, state, choices } = clickOn(ctx, message.blocks)
  await requireChoices(ctx, choices)
  const thread = message.thread_ts
  const payload = {
    type: "block_actions",
    user: interactor(user, c.team_id),
    api_app_id: app.id,
    token: "",
    container: {
      type: "message",
      message_ts: ts,
      channel_id: c.id,
      is_ephemeral: true,
      ...(thread ? { thread_ts: thread } : {}),
    },
    trigger_id: triggerId(),
    team: { id: ctx.auth.team.id, domain: ctx.auth.team.domain },
    enterprise: null,
    is_enterprise_install: false,
    channel: { id: c.id, name: channelName(c) },
    state: { values: state },
    response_url: await issueResponseUrl(ctx.env.SIGNING_KEY, ctx.origin, {
      teamId: c.team_id,
      channelId: c.id,
      ts,
      ...(thread ? { threadTs: thread } : {}),
      ephemeral: true,
      appId: app.id,
      userId: user.id,
    }),
    actions: [action],
  }
  return deliverInteraction(ctx, app, payload)
}

/** A click in a view: block_actions with the view, and its inputs' state, instead of a message. */
async function inView(ctx: Ctx<Actor>) {
  const found = await findView(ctx, { id: ctx.args.str("view_id") })
  if (!found || found.userId !== ctx.auth.user.id) throw new CampflareError("not_found")
  const view = found.stack[found.index]!.view
  const app = await first<AppRow>(
    ctx.env.DB,
    "SELECT * FROM apps WHERE id = ? AND team_id = ?",
    view.app_id,
    ctx.auth.team.id,
  )
  if (!app) throw new CampflareError("not_found")
  const { action, choices } = clickOn(ctx, view.blocks)
  // What's typed so far goes along, as on Slack; an incomplete form is fine here.
  const form = formState(view, givenValues(ctx.args.json("values")))
  await requireChoices(ctx, [...choices, ...form.choices])
  const payload = {
    type: "block_actions",
    user: interactor(ctx.auth.user, ctx.auth.team.id),
    api_app_id: app.id,
    token: "",
    container: { type: "view", view_id: view.id },
    trigger_id: triggerId(),
    team: { id: ctx.auth.team.id, domain: ctx.auth.team.domain },
    enterprise: null,
    is_enterprise_install: false,
    view: { ...view, state: { values: form.values } },
    actions: [action],
  }
  return deliverInteraction(ctx, app, payload)
}
