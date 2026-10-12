import { requireNotArchived, requireReadable, requireWritable, resolveConversation } from "../db/conversations"
import { announceChanged, messageOut, postMessage, requireMessage, MAX_TEXT, type NewMessage } from "../db/messages"
import { all, run } from "../db/query"
import type { MessageRow } from "../db/rows"
import { audienceOf, channelType, publish } from "../events"
import { method, type Actor, type Ctx } from "../api/context"
import { CampflareError } from "../api/errors"
import { nextTs } from "../api/ids"
import { permalink } from "../api/shapes"

/** Who a message is from: the person, or the bot with its app. */
function authorOf(ctx: Ctx<Actor>): Pick<NewMessage, "user_id" | "bot_id" | "app_id" | "username"> {
  const { user, app, kind } = ctx.auth
  if (kind === "bot" && app) {
    return { user_id: user.id, bot_id: app.bot_id, app_id: app.id, username: ctx.args.str("username") ?? null }
  }
  return { user_id: user.id }
}

/** text, blocks and attachments as given; at least one must say something. */
function content(ctx: Ctx<Actor>, required = true) {
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
    blocks: hasBlocks ? JSON.stringify(blocks) : null,
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
  const ts = nextTs()
  // Ephemeral messages are never stored: only the recipient's live clients see them.
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
      ...(ctx.args.ts("thread_ts") ? { thread_ts: ctx.args.ts("thread_ts") } : {}),
    },
  })
  return { message_ts: ts }
})

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
  const next = content(ctx, !message.files)
  const ts = nextTs()
  await run(
    ctx.env.DB,
    `UPDATE messages SET text = ?, blocks = ?, attachments = COALESCE(?, attachments), edited_ts = ?, edited_user = ?
     WHERE channel_id = ? AND ts = ?`,
    next.text,
    next.blocks,
    next.attachments,
    ts,
    ctx.auth.user.id,
    c.id,
    message.ts,
  )
  const updated = await requireMessage(ctx, c.id, message.ts)
  await announceChanged(ctx, c, message, updated)
  return { channel: c.id, ts: message.ts, text: updated.text, message: await messageOut(ctx, updated) }
})

method("chat.delete", "actor", async (ctx) => {
  const { c, message } = await ownMessage(ctx, "delete")
  const audience = await audienceOf(ctx, c.id)
  if (message.thread_ts === message.ts && message.reply_count > 0) {
    // A thread head with replies stays as a tombstone, so its replies stay reachable.
    await run(
      ctx.env.DB,
      `UPDATE messages SET subtype = 'tombstone', text = 'This message was deleted.', user_id = 'USLACKBOT',
         bot_id = NULL, app_id = NULL, blocks = NULL, attachments = NULL, files = NULL, edited_ts = NULL
       WHERE channel_id = ? AND ts = ?`,
      c.id,
      message.ts,
    )
    await announceChanged(ctx, c, message, await requireMessage(ctx, c.id, message.ts))
  } else {
    await ctx.env.DB.batch([
      ctx.env.DB.prepare("UPDATE messages SET deleted = 1 WHERE channel_id = ? AND ts = ?").bind(c.id, message.ts),
      ctx.env.DB.prepare("DELETE FROM reactions WHERE channel_id = ? AND ts = ?").bind(c.id, message.ts),
    ])
    if (message.thread_ts && message.thread_ts !== message.ts) await recountThread(ctx, c.id, message.thread_ts)
    const now = `${(Date.now() / 1000).toFixed(6)}`
    publish(ctx, {
      teamId: c.team_id,
      audience,
      event: {
        type: "message",
        subtype: "message_deleted",
        hidden: true,
        channel: c.id,
        channel_type: channelType(c),
        ts: now,
        event_ts: now,
        deleted_ts: message.ts,
        previous_message: await messageOut(ctx, message),
      },
    })
  }
  return { channel: c.id, ts: message.ts }
})

/** After a reply goes, the parent's reply count, latest reply and repliers follow. */
async function recountThread(ctx: Ctx<Actor>, channelId: string, threadTs: string) {
  const replies = await all<Pick<MessageRow, "ts" | "user_id" | "bot_id">>(
    ctx.env.DB,
    "SELECT ts, user_id, bot_id FROM messages WHERE channel_id = ? AND thread_ts = ? AND ts != ? AND deleted = 0 ORDER BY ts",
    channelId,
    threadTs,
    threadTs,
  )
  const users = [...new Set(replies.flatMap((r) => ((r.user_id ?? r.bot_id) ? [(r.user_id ?? r.bot_id)!] : [])))]
  await run(
    ctx.env.DB,
    "UPDATE messages SET reply_count = ?, latest_reply = ?, reply_users = ? WHERE channel_id = ? AND ts = ?",
    replies.length,
    replies.at(-1)?.ts ?? null,
    JSON.stringify(users.slice(0, 50)),
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
