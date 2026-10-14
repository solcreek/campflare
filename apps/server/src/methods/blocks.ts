import { getConversation, requireNotArchived, requireReadable } from "../db/conversations"
import { reactionsStatement } from "../db/messages"
import { stmt } from "../db/query"
import type { AppRow, MessageRow, ReactionRow } from "../db/rows"
import { method } from "../api/context"
import { CampflareError } from "../api/errors"
import { loadExtras, messageJson } from "../api/shapes"
import { actionOf, channelName, ID_SELECTS, issueResponseUrl, requireChoices, triggerId } from "../interactivity"
import { postSigned } from "../request-url"

/**
 * A person clicks a button, or chooses in a select menu, in an app's message
 * (Campflare's own method; a Slack client uses an internal one). `channel`,
 * `ts` (the message), `action_id`, and `block_id` when several blocks share
 * the action_id. `value` names a feedback button, a static_select's or an
 * overflow's option, or the person or conversation chosen in a users,
 * conversations or channels select. The app whose bot posted
 * the message gets block_actions, as Slack sends it: over Socket Mode when it
 * has a link (an `interactive` envelope it must ack), else POSTed to its
 * Interactivity Request URL. Clicks aren't retried: an app that doesn't take
 * it within 3 seconds is the clicker's error, `app_unreachable`.
 */
method("campflare.blocks.action", "user", async (ctx) => {
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
  if (!message) throw new CampflareError("message_not_found")
  const app = apps!.results[0] as AppRow | undefined
  // Only an app's messages answer clicks: a person's blocks have nobody to go to.
  if (!app) throw new CampflareError("not_interactive")
  const now = `${(Date.now() / 1000).toFixed(6)}`
  const { action, state } = actionOf(
    message.blocks ? JSON.parse(message.blocks) : undefined,
    { blockId: ctx.args.str("block_id"), actionId: ctx.args.req("action_id"), value: ctx.args.str("value") },
    now,
  )
  const field = ID_SELECTS[action.type as string]
  if (field) await requireChoices(ctx, [{ field, id: action[field] as string }])
  const user = ctx.auth.user
  const reply = message.thread_ts && message.thread_ts !== message.ts ? message.thread_ts : undefined
  const extras = await loadExtras(ctx.env, [message], reactions!.results as ReactionRow[])
  const payload = {
    type: "block_actions",
    user: { id: user.id, username: user.name, name: user.name, team_id: c.team_id },
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

  const hub = ctx.env.HUB.get(ctx.env.HUB.idFromName(c.team_id))
  const socket = await hub.interact(app.id, payload)
  if (socket === "acked") return { delivered: "socket" }
  if (socket === "timeout") throw unreachable("its Socket Mode connection didn't acknowledge within 3 seconds")
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
  return { delivered: "http" }
})

const unreachable = (why: string) =>
  new CampflareError("app_unreachable", { response_metadata: { messages: [`[ERROR] the app didn't take it: ${why}`] } })
