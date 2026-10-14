import { getConversation, requireReadable } from "../db/conversations"
import { stmt } from "../db/query"
import { audienceFrom, audienceStatement, channelType, publish } from "../events"
import { method } from "../api/context"
import { CampflareError, invalidArguments } from "../api/errors"

// assistant.threads.setStatus: an app's transient status in a thread ("is
// thinking…"), shown until the app's next reply there or an empty status, and
// for two minutes at most. The status goes out as an RTM event,
// `assistant_thread_status_changed`, to the conversation's members' clients,
// which clear it themselves on the app's next message in the thread. Apps don't
// get it (it is client state, like `channel_marked`). The hub keeps the latest
// one per thread until then, and gives it to RTM links that open later
// (TeamHub.keepStatus/statusesFor): nothing goes to D1.

/** How long a status shows without a reply, as in Slack. */
export const STATUS_TIMEOUT_SECONDS = 120

method("assistant.threads.setStatus", "bot", async (ctx) => {
  const status = ctx.args.values.status
  if (typeof status !== "string") throw invalidArguments("missing required field: status")
  const loading = ctx.args.json<unknown>("loading_messages") ?? []
  if (!Array.isArray(loading) || loading.length > 10 || !loading.every((m) => typeof m === "string"))
    throw invalidArguments("loading_messages must be an array of at most 10 strings")
  const c = await getConversation(ctx, ctx.args.req("channel_id", "channel_not_found"))
  await requireReadable(ctx, c)
  const raw = ctx.args.str("thread_ts")
  if (!raw) throw new CampflareError("invalid_thread_ts")
  let threadTs: string | undefined
  try {
    threadTs = ctx.args.ts("thread_ts")
  } catch {
    throw new CampflareError("invalid_thread_ts")
  }
  const db = ctx.env.DB
  const [thread, audience] = await db.batch([
    stmt(db, "SELECT ts FROM messages WHERE channel_id = ? AND ts = ? AND deleted = 0", c.id, threadTs),
    audienceStatement(db, c.id),
  ])
  if (thread!.results.length === 0) throw new CampflareError("invalid_thread_ts")
  const app = ctx.auth.app!
  const now = `${(Date.now() / 1000).toFixed(6)}`
  publish(ctx, {
    teamId: c.team_id,
    audience: audienceFrom(audience!),
    rtmOnly: true,
    event: {
      type: "assistant_thread_status_changed",
      channel: c.id,
      channel_type: channelType(c),
      thread_ts: threadTs,
      status,
      ...(status && loading.length > 0 ? { loading_messages: loading } : {}),
      user: ctx.auth.user.id,
      bot_id: app.bot_id,
      app_id: app.id,
      ...(ctx.args.str("username") ? { username: ctx.args.str("username") } : {}),
      expires_in: STATUS_TIMEOUT_SECONDS,
      event_ts: now,
    },
  })
  return {}
})
