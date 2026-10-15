import { announceActivity, messageActivity } from "../activity"
import { audienceFrom, audienceStatement, channelType, publish } from "../events"
import type { Actor, Ctx } from "../api/context"
import { CampflareError } from "../api/errors"
import { nextTs } from "../api/ids"
import { loadExtras, messageJson, type MessageExtras } from "../api/shapes"
import { first, isUniqueViolation, stmt } from "./query"
import type { ConversationRow, MessageRow } from "./rows"

export const MAX_TEXT = 40_000

export type NewMessage = Partial<
  Pick<
    MessageRow,
    | "user_id"
    | "bot_id"
    | "app_id"
    | "username"
    | "subtype"
    | "blocks"
    | "attachments"
    | "metadata"
    | "files"
    | "thread_ts"
    | "client_msg_id"
    | "stream_state"
    | "stream_mode"
    | "stream_task_display"
  >
> & { text: string }

export async function getMessage(ctx: Pick<Ctx, "env">, channelId: string, ts: string) {
  return first<MessageRow>(
    ctx.env.DB,
    "SELECT * FROM messages WHERE channel_id = ? AND ts = ? AND deleted = 0",
    channelId,
    ts,
  )
}

export async function requireMessage(ctx: Pick<Ctx, "env">, channelId: string, ts: string) {
  const row = await getMessage(ctx, channelId, ts)
  if (!row) throw new CampflareError("message_not_found")
  return row
}

/** Serialises one message with its reactions and files. */
export async function messageOut(ctx: Pick<Ctx, "env" | "origin">, row: MessageRow) {
  return messageJson(row, await loadExtras(ctx.env, [row]), ctx.origin)
}

/** What a message needs to serialise when it was just posted: no reactions yet, and usually no bot but the caller's. */
async function newMessageExtras(ctx: Ctx<Actor>, row: MessageRow): Promise<MessageExtras> {
  const app = ctx.auth.app
  if (row.files || (row.bot_id && app?.bot_id !== row.bot_id)) return loadExtras(ctx.env, [row])
  return { reactions: new Map(), files: new Map(), apps: new Map(app ? [[app.bot_id, app]] : []) }
}

/**
 * Stores a message and announces it. A reply (thread_ts) updates its parent's
 * thread summary; the parent becomes a thread head (thread_ts = its own ts).
 * The writes, the stored row and the audience are one batch: one round trip,
 * and the message and its thread summary land together or not at all.
 */
export async function postMessage(
  ctx: Ctx<Actor>,
  c: ConversationRow,
  input: NewMessage,
): Promise<{ row: MessageRow; message: ReturnType<typeof messageJson> }> {
  if (input.text.length > MAX_TEXT) throw new CampflareError("msg_too_long")
  let parent: MessageRow | undefined
  if (input.thread_ts) {
    parent = await getMessage(ctx, c.id, input.thread_ts)
    if (!parent) throw new CampflareError("thread_not_found")
    // Replying to a reply lands in its thread, as Slack does.
    if (parent.thread_ts && parent.thread_ts !== parent.ts) {
      parent = await requireMessage(ctx, c.id, parent.thread_ts)
    }
  }
  let replyUsers: string[] = []
  if (parent) {
    replyUsers = JSON.parse(parent.reply_users) as string[]
    const author = input.user_id ?? input.bot_id
    if (author && !replyUsers.includes(author)) replyUsers.push(author)
  }

  const db = ctx.env.DB
  const author = input.user_id ?? null
  // The items it makes (mentions, DMs, thread replies), in the same batch.
  const activity = (ts: string) =>
    messageActivity(db, c, {
      ts,
      thread_ts: parent?.ts ?? null,
      user_id: author,
      subtype: input.subtype ?? null,
      text: input.text,
    })
  let hasItems = false
  const write = (ts: string) => {
    const items = activity(ts)
    hasItems = items !== undefined
    return db.batch([
      stmt(
        db,
        `INSERT INTO messages (channel_id, ts, team_id, user_id, bot_id, app_id, username, subtype, text, blocks,
           attachments, metadata, files, thread_ts, parent_user_id, client_msg_id, stream_state, stream_mode,
           stream_task_display)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        c.id,
        ts,
        c.team_id,
        input.user_id ?? null,
        input.bot_id ?? null,
        input.app_id ?? null,
        input.username ?? null,
        input.subtype ?? null,
        input.text,
        input.blocks ?? null,
        input.attachments ?? null,
        input.metadata ?? null,
        input.files ?? null,
        parent?.ts ?? null,
        parent?.user_id ?? null,
        input.client_msg_id ?? null,
        input.stream_state ?? null,
        input.stream_mode ?? null,
        input.stream_task_display ?? null,
      ),
      ...(parent
        ? [
            stmt(
              db,
              `UPDATE messages SET thread_ts = ts, reply_count = reply_count + 1, latest_reply = ?, reply_users = ?
               WHERE channel_id = ? AND ts = ?`,
              ts,
              JSON.stringify(replyUsers.slice(0, 50)),
              c.id,
              parent.ts,
            ),
          ]
        : []),
      stmt(db, "UPDATE conversations SET updated = ? WHERE id = ?", Math.floor(Date.now() / 1000), c.id),
      ...(items ? [items] : []),
      stmt(db, "SELECT * FROM messages WHERE channel_id = ? AND ts = ?", c.id, ts),
      audienceStatement(db, c.id),
    ])
  }

  let ts = nextTs()
  let results: D1Result[]
  for (let attempt = 0; ; attempt++) {
    try {
      results = await write(ts)
      break
    } catch (error) {
      if (!isUniqueViolation(error) || attempt >= 5) throw error
      ts = nextTs(ts)
    }
  }

  const row = results.at(-2)!.results[0] as MessageRow
  const audience = audienceFrom(results.at(-1)!)
  const message = messageJson(row, await newMessageExtras(ctx, row), ctx.origin)
  publish(ctx, {
    teamId: c.team_id,
    audience,
    event: { ...message, channel: c.id, channel_type: channelType(c), event_ts: ts },
  })
  if (hasItems) announceActivity(ctx, c.team_id, results.at(-3), message)
  return { row, message }
}
/** A message's reactions, as a statement to batch with a change to it. */
export const reactionsStatement = (db: D1Database, channelId: string, ts: string) =>
  db.prepare("SELECT * FROM reactions WHERE channel_id = ? AND ts = ? ORDER BY created").bind(channelId, ts)

/**
 * A message_changed event for a message edited (or tombstoned) in place, and
 * the edited message's JSON. An edit keeps the message's reactions, so the
 * extras loaded for `before` serve `after` too.
 */
export function announceChanged(
  ctx: Ctx<Actor>,
  c: ConversationRow,
  change: { before: MessageRow; after: MessageRow; audience: string[]; extras: MessageExtras },
) {
  const { before, after, audience, extras } = change
  const message = messageJson(after, extras, ctx.origin)
  const now = `${(Date.now() / 1000).toFixed(6)}`
  publish(ctx, {
    teamId: c.team_id,
    audience,
    event: {
      type: "message",
      subtype: "message_changed",
      hidden: true,
      channel: c.id,
      channel_type: channelType(c),
      ts: now,
      event_ts: now,
      message,
      previous_message: messageJson(before, extras, ctx.origin),
    },
  })
  return message
}
