import { requireNotArchived, requireReadable, requireWritable, resolveConversation } from "../db/conversations"
import {
  announceChanged,
  postMessage,
  reactionsStatement,
  requireMessage,
  MAX_TEXT,
  type NewMessage,
} from "../db/messages"
import { stmt } from "../db/query"
import type { ConversationRow, MessageRow, ReactionRow } from "../db/rows"
import { audienceFrom, audienceOf, audienceStatement, channelType, publish } from "../events"
import { method, type Actor, type Ctx } from "../api/context"
import { CampflareError } from "../api/errors"
import { nextTs } from "../api/ids"
import { loadExtras, messageJson, permalink } from "../api/shapes"

/** Who a message is from: the person, or the bot with its app. */
export function authorOf(ctx: Ctx<Actor>): Pick<NewMessage, "user_id" | "bot_id" | "app_id" | "username"> {
  const { user, app, kind } = ctx.auth
  if (kind === "bot" && app) {
    return { user_id: user.id, bot_id: app.bot_id, app_id: app.id, username: ctx.args.str("username") ?? null }
  }
  return { user_id: user.id }
}

/**
 * Block Kit blocks as stored: as given, with a block_id on every block and an
 * action_id on every element of an actions or context_actions block that
 * lacks one, as Slack fills them in, so a click can always say which it was.
 */
export function withBlockIds(blocks: unknown[]): unknown[] {
  return blocks.map((block) => {
    if (!block || typeof block !== "object" || Array.isArray(block)) return block
    const b = { ...(block as Record<string, unknown>) }
    if (typeof b.block_id !== "string" || !b.block_id) b.block_id = shortId()
    if ((b.type === "actions" || b.type === "context_actions") && Array.isArray(b.elements)) {
      b.elements = b.elements.map((element: unknown) => {
        if (!element || typeof element !== "object" || Array.isArray(element)) return element
        const e = element as Record<string, unknown>
        return typeof e.action_id === "string" && e.action_id ? e : { ...e, action_id: shortId() }
      })
    }
    return b
  })
}

const ID_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789"

/** A short random id like Slack's generated block and action ids ("aZ3kQ"). */
function shortId(): string {
  return [...crypto.getRandomValues(new Uint8Array(5))].map((b) => ID_CHARS[b % ID_CHARS.length]).join("")
}

/** text, blocks and attachments as given; at least one must say something. */
export function content(ctx: Ctx<Actor>, required = true) {
  const text = ctx.args.str("text") ?? ""
  const blocks = ctx.args.json<unknown>("blocks", "invalid_blocks")
  const attachments = ctx.args.json<unknown>("attachments", "invalid_attachments")
  if (blocks !== undefined && !Array.isArray(blocks)) throw new CampflareError("invalid_blocks")
  if (attachments !== undefined && !Array.isArray(attachments)) throw new CampflareError("invalid_attachments")
  const hasBlocks = Array.isArray(blocks) && blocks.length > 0
  const hasAttachments = Array.isArray(attachments) && attachments.length > 0
  if (required && !text && !hasBlocks && !hasAttachments) throw new CampflareError("no_text")
  if (text.length > MAX_TEXT) throw new CampflareError("msg_too_long")
  if (Array.isArray(blocks) && blocks.length > 50) throw new CampflareError("invalid_blocks")
  return {
    text,
    blocks: hasBlocks ? JSON.stringify(withBlockIds(blocks)) : null,
    attachments: hasAttachments ? JSON.stringify(attachments) : null,
  }
}

method("chat.postMessage", "actor", async (ctx) => {
  const c = await resolveConversation(ctx, ctx.args.req("channel", "channel_not_found"))
  await requireWritable(ctx, c)
  const threadTs = ctx.args.ts("thread_ts")
  const metadata = ctx.args.json<unknown>("metadata", "invalid_metadata_format")
  const { row, message } = await postMessage(ctx, c, {
    ...authorOf(ctx),
    ...content(ctx),
    thread_ts: threadTs ?? null,
    subtype: threadTs && ctx.args.bool("reply_broadcast") ? "thread_broadcast" : null,
    metadata: metadata ? JSON.stringify(metadata) : null,
    client_msg_id: ctx.args.str("client_msg_id") ?? null,
  })
  return { channel: c.id, ts: row.ts, message }
})

method("chat.meMessage", "user", async (ctx) => {
  const c = await resolveConversation(ctx, ctx.args.req("channel", "channel_not_found"))
  await requireWritable(ctx, c)
  const text = ctx.args.req("text", "no_text")
  const { row } = await postMessage(ctx, c, { user_id: ctx.auth.user.id, subtype: "me_message", text })
  return { channel: c.id, ts: row.ts }
})

method("chat.postEphemeral", "actor", async (ctx) => {
  const c = await resolveConversation(ctx, ctx.args.req("channel", "channel_not_found"))
  await requireWritable(ctx, c)
  const user = ctx.args.req("user", "user_not_in_channel")
  const members = await audienceOf(ctx, c.id)
  if (!members.includes(user)) throw new CampflareError("user_not_in_channel")
  return { message_ts: sendEphemeral(ctx, c, user, ctx.args.ts("thread_ts")) }
})

/**
 * An ephemeral message of the caller's content to one person; its ts.
 * Never stored: only the recipient's live clients see it.
 */
export function sendEphemeral(ctx: Ctx<Actor>, c: ConversationRow, user: string, threadTs?: string): string {
  const ts = nextTs()
  publish(ctx, {
    teamId: c.team_id,
    audience: [user],
    rtmOnly: true,
    event: {
      type: "message",
      subtype: "ephemeral",
      is_ephemeral: true,
      ...authorOf(ctx),
      ...content(ctx),
      channel: c.id,
      channel_type: channelType(c),
      ts,
      ...(threadTs ? { thread_ts: threadTs } : {}),
    },
  })
  return ts
}

async function ownMessage(ctx: Ctx<Actor>, verb: "update" | "delete") {
  const c = await resolveConversation(ctx, ctx.args.req("channel", "channel_not_found"))
  await requireReadable(ctx, c)
  const ts = ctx.args.ts("ts")
  if (!ts) throw new CampflareError("message_not_found")
  const message = await requireMessage(ctx, c.id, ts)
  const own = message.user_id === ctx.auth.user.id
  // Admins may delete anyone's message with a user token, as in Slack; nobody edits anyone else's.
  const allowed = own || (verb === "delete" && ctx.auth.kind === "user" && ctx.auth.user.is_admin)
  if (!allowed || message.subtype === "tombstone") throw new CampflareError(`cant_${verb}_message`)
  return { c, message }
}

method("chat.update", "actor", async (ctx) => {
  const { c, message } = await ownMessage(ctx, "update")
  requireNotArchived(c)
  const updated = await editMessage(ctx, c, message)
  return { channel: c.id, ts: message.ts, ...updated }
})

/**
 * Replaces a message's content with the caller's, and announces the change.
 * An app replacing its message through a response_url (`quiet`) doesn't mark
 * it edited: Slack shows no "(edited)" for those.
 */
export async function editMessage(
  ctx: Ctx<Actor>,
  c: ConversationRow,
  message: MessageRow,
  { quiet = false }: { quiet?: boolean } = {},
) {
  const next = content(ctx, !message.files)
  const db = ctx.env.DB
  // The edit, the edited row, the audience and the reactions: one round trip.
  const [, edited, audience, reactions] = await db.batch([
    stmt(
      db,
      `UPDATE messages SET text = ?, blocks = ?, attachments = COALESCE(?, attachments),
         edited_ts = COALESCE(?, edited_ts), edited_user = COALESCE(?, edited_user)
       WHERE channel_id = ? AND ts = ?`,
      next.text,
      next.blocks,
      next.attachments,
      quiet ? null : nextTs(),
      quiet ? null : ctx.auth.user.id,
      c.id,
      message.ts,
    ),
    stmt(db, "SELECT * FROM messages WHERE channel_id = ? AND ts = ?", c.id, message.ts),
    audienceStatement(db, c.id),
    reactionsStatement(db, c.id, message.ts),
  ])
  const updated = edited!.results[0] as MessageRow
  const json = announceChanged(ctx, c, {
    before: message,
    after: updated,
    audience: audienceFrom(audience!),
    extras: await loadExtras(ctx.env, [message], reactions!.results as ReactionRow[]),
  })
  return { text: updated.text, message: json }
}

method("chat.delete", "actor", async (ctx) => {
  const { c, message } = await ownMessage(ctx, "delete")
  await deleteMessage(ctx, c, message)
  return { channel: c.id, ts: message.ts }
})

/** Deletes a message (a thread head with replies stays as a tombstone), and announces it. */
export async function deleteMessage(ctx: Ctx<Actor>, c: ConversationRow, message: MessageRow) {
  const db = ctx.env.DB
  if (message.thread_ts === message.ts && message.reply_count > 0) {
    // A thread head with replies stays as a tombstone, so its replies stay reachable.
    const [, tombstone, audience, reactions] = await db.batch([
      stmt(
        db,
        `UPDATE messages SET subtype = 'tombstone', text = 'This message was deleted.', user_id = 'USLACKBOT',
           bot_id = NULL, app_id = NULL, blocks = NULL, attachments = NULL, files = NULL, edited_ts = NULL
         WHERE channel_id = ? AND ts = ?`,
        c.id,
        message.ts,
      ),
      stmt(db, "SELECT * FROM messages WHERE channel_id = ? AND ts = ?", c.id, message.ts),
      audienceStatement(db, c.id),
      reactionsStatement(db, c.id, message.ts),
    ])
    announceChanged(ctx, c, {
      before: message,
      after: tombstone!.results[0] as MessageRow,
      audience: audienceFrom(audience!),
      extras: await loadExtras(ctx.env, [message], reactions!.results as ReactionRow[]),
    })
  } else {
    // Its reactions are read for the event before they go; a reply's thread is recounted in the same batch.
    const isReply = Boolean(message.thread_ts && message.thread_ts !== message.ts)
    const [reactions, audience] = await db.batch([
      reactionsStatement(db, c.id, message.ts),
      audienceStatement(db, c.id),
      stmt(db, "UPDATE messages SET deleted = 1 WHERE channel_id = ? AND ts = ?", c.id, message.ts),
      stmt(db, "DELETE FROM reactions WHERE channel_id = ? AND ts = ?", c.id, message.ts),
      ...(isReply ? [recountThread(db, c.id, message.thread_ts!)] : []),
    ])
    const extras = await loadExtras(ctx.env, [message], reactions!.results as ReactionRow[])
    const now = `${(Date.now() / 1000).toFixed(6)}`
    publish(ctx, {
      teamId: c.team_id,
      audience: audienceFrom(audience!),
      event: {
        type: "message",
        subtype: "message_deleted",
        hidden: true,
        channel: c.id,
        channel_type: channelType(c),
        ts: now,
        event_ts: now,
        deleted_ts: message.ts,
        previous_message: messageJson(message, extras, ctx.origin),
      },
    })
  }
}

/**
 * After a reply goes, the parent's reply count, latest reply and repliers
 * (the first 50, in order of their first reply) follow: a statement, to batch
 * after the delete.
 */
function recountThread(db: D1Database, channelId: string, threadTs: string) {
  const replies = "FROM messages r WHERE r.channel_id = ?1 AND r.thread_ts = ?2 AND r.ts != ?2 AND r.deleted = 0"
  return stmt(
    db,
    `UPDATE messages SET
       reply_count = (SELECT COUNT(*) ${replies}),
       latest_reply = (SELECT MAX(r.ts) ${replies}),
       reply_users = (SELECT json_group_array(u) FROM (
         SELECT COALESCE(r.user_id, r.bot_id) AS u ${replies} AND u IS NOT NULL GROUP BY u ORDER BY MIN(r.ts) LIMIT 50))
     WHERE channel_id = ?1 AND ts = ?2`,
    channelId,
    threadTs,
  )
}

method("chat.getPermalink", "actor", async (ctx) => {
  const c = await resolveConversation(ctx, ctx.args.req("channel", "channel_not_found"))
  await requireReadable(ctx, c)
  const ts = ctx.args.ts("message_ts")
  if (!ts) throw new CampflareError("message_not_found")
  const message = await requireMessage(ctx, c.id, ts)
  return { channel: c.id, permalink: permalink(ctx.origin, c.id, message.ts, message.thread_ts) }
})
