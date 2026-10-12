import { audienceOf, channelType, publish } from "../events"
import type { Actor, Ctx } from "../api/context"
import { CampflareError } from "../api/errors"
import { nextTs } from "../api/ids"
import { loadExtras, messageJson } from "../api/shapes"
import { first, isUniqueViolation, run } from "./query"
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

/**
 * Stores a message and announces it. A reply (thread_ts) updates its parent's
 * thread summary; the parent becomes a thread head (thread_ts = its own ts).
 */
export async function postMessage(ctx: Ctx<Actor>, c: ConversationRow, input: NewMessage): Promise<MessageRow> {
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

  let ts = nextTs()
  for (let attempt = 0; ; attempt++) {
    try {
      await run(
        ctx.env.DB,
        `INSERT INTO messages (channel_id, ts, team_id, user_id, bot_id, app_id, username, subtype, text, blocks,
           attachments, metadata, files, thread_ts, parent_user_id, client_msg_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
      )
      break
    } catch (error) {
      if (!isUniqueViolation(error) || attempt >= 5) throw error
      ts = nextTs(ts)
    }
  }

  if (parent) {
    const replyUsers = JSON.parse(parent.reply_users) as string[]
    const author = input.user_id ?? input.bot_id
    if (author && !replyUsers.includes(author)) replyUsers.push(author)
    await run(
      ctx.env.DB,
      `UPDATE messages SET thread_ts = ts, reply_count = reply_count + 1, latest_reply = ?, reply_users = ?
       WHERE channel_id = ? AND ts = ?`,
      ts,
      JSON.stringify(replyUsers.slice(0, 50)),
      c.id,
      parent.ts,
    )
  }
  await run(ctx.env.DB, "UPDATE conversations SET updated = ? WHERE id = ?", Math.floor(Date.now() / 1000), c.id)

  const row = (await getMessage(ctx, c.id, ts))!
  const json = await messageOut(ctx, row)
  publish(ctx, {
    teamId: c.team_id,
    audience: await audienceOf(ctx, c.id),
    event: { ...json, channel: c.id, channel_type: channelType(c), event_ts: ts },
  })
  return row
}

/** A message_changed event for an edited (or tombstoned) message. */
export async function announceChanged(ctx: Ctx<Actor>, c: ConversationRow, before: MessageRow, after: MessageRow) {
  const now = `${(Date.now() / 1000).toFixed(6)}`
  publish(ctx, {
    teamId: c.team_id,
    audience: await audienceOf(ctx, c.id),
    event: {
      type: "message",
      subtype: "message_changed",
      hidden: true,
      channel: c.id,
      channel_type: channelType(c),
      ts: now,
      event_ts: now,
      message: await messageOut(ctx, after),
      previous_message: await messageOut(ctx, before),
    },
  })
}
