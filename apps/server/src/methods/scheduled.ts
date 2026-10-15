import { decodeCursor, encodeCursor } from "../api/args"
import { method, type Actor, type Ctx } from "../api/context"
import { CampflareError } from "../api/errors"
import { nowSeconds, randomId } from "../api/ids"
import { requireWritable, resolveConversation } from "../db/conversations"
import { all, first, stmt } from "../db/query"
import type { ScheduledMessageRow } from "../db/rows"
import { publish } from "../events"
import { armScheduler, removed } from "../scheduler"
import { authorOf, content } from "./chat"

// chat.scheduleMessage and friends (docs/scheduling.md): the message waits in
// D1 and the workspace's Scheduler posts it at post_at, as its poster.

/** How far ahead a message may be scheduled, as on Slack. */
export const MAX_SCHEDULE_SECONDS = 120 * 86_400
/** At most this many scheduled messages per channel within RESTRICT_WINDOW seconds either side, as on Slack. */
export const MAX_IN_WINDOW = 30
const RESTRICT_WINDOW = 300

/** A list entry, as Slack's chat.scheduledMessages.list gives it. */
function listed(r: ScheduledMessageRow) {
  return {
    id: r.id,
    channel_id: r.channel_id,
    post_at: r.post_at,
    date_created: r.created,
    text: r.text,
    ...(r.thread_ts ? { thread_ts: r.thread_ts } : {}),
  }
}

/** The channel id a `channel` argument names: an id as it is, else resolved (a #name). */
async function channelIdOf(ctx: Ctx<Actor>, ref: string) {
  return /^[CDG][A-Z0-9]+$/.test(ref) ? ref : (await resolveConversation(ctx, ref)).id
}

method("chat.scheduleMessage", "actor", async (ctx) => {
  const c = await resolveConversation(ctx, ctx.args.req("channel", "channel_not_found"))
  await requireWritable(ctx, c)
  const raw = ctx.args.str("post_at")
  const postAt = raw === undefined ? Number.NaN : Math.floor(Number(raw))
  if (!Number.isFinite(postAt)) throw new CampflareError("invalid_time")
  const now = nowSeconds()
  if (postAt <= now) throw new CampflareError("time_in_past")
  if (postAt > now + MAX_SCHEDULE_SECONDS) throw new CampflareError("time_too_far")
  const body = content(ctx)
  const author = authorOf(ctx)
  const threadTs = ctx.args.ts("thread_ts")
  const metadata = ctx.args.json<unknown>("metadata", "invalid_metadata_format")

  const db = ctx.env.DB
  const [crowd, parent] = await db.batch([
    stmt(
      db,
      "SELECT COUNT(*) AS n FROM scheduled_messages WHERE channel_id = ? AND post_at BETWEEN ? AND ?",
      c.id,
      postAt - RESTRICT_WINDOW,
      postAt + RESTRICT_WINDOW,
    ),
    stmt(db, "SELECT ts FROM messages WHERE channel_id = ? AND ts = ? AND deleted = 0", c.id, threadTs ?? ""),
  ])
  if ((crowd!.results[0] as { n: number }).n >= MAX_IN_WINDOW) throw new CampflareError("restricted_too_many")
  if (threadTs && !parent!.results.length) throw new CampflareError("thread_not_found")

  const row: ScheduledMessageRow = {
    id: randomId("Q"),
    team_id: c.team_id,
    channel_id: c.id,
    user_id: ctx.auth.user.id,
    app_id: author.app_id ?? null,
    username: author.username ?? null,
    text: body.text,
    blocks: body.blocks,
    attachments: body.attachments,
    metadata: metadata ? JSON.stringify(metadata) : null,
    thread_ts: threadTs ?? null,
    reply_broadcast: threadTs && ctx.args.bool("reply_broadcast") ? 1 : 0,
    post_at: postAt,
    created: now,
    origin: ctx.origin,
    claimed_until: null,
    attempts: 0,
  }
  await db
    .prepare(
      `INSERT INTO scheduled_messages (id, team_id, channel_id, user_id, app_id, username, text, blocks, attachments,
         metadata, thread_ts, reply_broadcast, post_at, created, origin) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      row.id,
      row.team_id,
      row.channel_id,
      row.user_id,
      row.app_id,
      row.username,
      row.text,
      row.blocks,
      row.attachments,
      row.metadata,
      row.thread_ts,
      row.reply_broadcast,
      row.post_at,
      row.created,
      row.origin,
    )
    .run()
  // Answered only once the alarm is set: an ok means it will fire.
  await armScheduler(ctx.env, c.team_id, postAt)
  publish(ctx, {
    teamId: c.team_id,
    audience: [row.user_id],
    rtmOnly: true,
    event: { type: "scheduled_message_added", scheduled_message: listed(row) },
  })
  return {
    channel: c.id,
    scheduled_message_id: row.id,
    post_at: postAt,
    message: {
      type: "delayed_message",
      text: row.text,
      user: row.user_id,
      team: c.team_id,
      ...(author.bot_id ? { bot_id: author.bot_id, app_id: author.app_id, subtype: "bot_message" } : {}),
      ...(row.username ? { username: row.username } : {}),
      ...(row.blocks ? { blocks: JSON.parse(row.blocks) as unknown[] } : {}),
      ...(row.attachments ? { attachments: JSON.parse(row.attachments) as unknown[] } : {}),
      ...(row.thread_ts ? { thread_ts: row.thread_ts } : {}),
    },
  }
})

/** The caller's own scheduled messages (a bot's, for a bot token), soonest first. */
method("chat.scheduledMessages.list", "actor", async (ctx) => {
  const limit = ctx.args.int("limit", 100, { min: 1, max: 1000 })
  const channel = ctx.args.str("channel")
  const oldest = ctx.args.str("oldest")
  const latest = ctx.args.str("latest")
  const cursor = decodeCursor(ctx.args.str("cursor"))
  const where = ["team_id = ?", "user_id = ?"]
  const params: unknown[] = [ctx.auth.team.id, ctx.auth.user.id]
  if (channel) {
    where.push("channel_id = ?")
    params.push(await channelIdOf(ctx, channel))
  }
  if (oldest !== undefined) {
    where.push("post_at >= ?")
    params.push(Number(oldest))
  }
  if (latest !== undefined) {
    where.push("post_at <= ?")
    params.push(Number(latest))
  }
  if (cursor) {
    const [at, id] = cursor.split(":")
    where.push("(post_at, id) > (?, ?)")
    params.push(Number(at), id)
  }
  const rows = await all<ScheduledMessageRow>(
    ctx.env.DB,
    `SELECT * FROM scheduled_messages WHERE ${where.join(" AND ")} ORDER BY post_at, id LIMIT ?`,
    ...params,
    limit + 1,
  )
  const page = rows.slice(0, limit)
  const last = page.at(-1)
  return {
    scheduled_messages: page.map(listed),
    response_metadata: { next_cursor: rows.length > limit && last ? encodeCursor(`${last.post_at}:${last.id}`) : "" },
  }
})

/** Deletes one of the caller's scheduled messages, unless it is being posted right now. */
method("chat.deleteScheduledMessage", "actor", async (ctx) => {
  const channel = await channelIdOf(ctx, ctx.args.req("channel", "channel_not_found"))
  const id = ctx.args.req("scheduled_message_id", "invalid_scheduled_message_id")
  const row = await first<ScheduledMessageRow>(
    ctx.env.DB,
    `DELETE FROM scheduled_messages WHERE id = ? AND channel_id = ? AND user_id = ? AND team_id = ?
       AND (claimed_until IS NULL OR claimed_until <= ?) RETURNING *`,
    id,
    channel,
    ctx.auth.user.id,
    ctx.auth.team.id,
    nowSeconds(),
  )
  if (!row) throw new CampflareError("invalid_scheduled_message_id")
  removed(ctx.env, row, (p) => ctx.waitUntil(p), { reason: "deleted" })
  return {}
})
