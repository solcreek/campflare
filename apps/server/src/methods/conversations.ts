import {
  actorMember,
  addMember,
  getConversation,
  imPeer,
  openConversation,
  removeMember,
  requireMember,
  requireNotArchived,
  requireReadable,
  validChannelName,
} from "../db/conversations"
import { postMessage } from "../db/messages"
import { all, first, isUniqueViolation, run, stmt } from "../db/query"
import type { ConversationRow, MessageRow, ReactionRow, UserRow } from "../db/rows"
import { audienceOf, publish } from "../events"
import { decodeCursor, encodeCursor } from "../api/args"
import { method, type Actor, type Ctx } from "../api/context"
import { CampflareError } from "../api/errors"
import { ids, nowSeconds } from "../api/ids"
import { conversationJson, loadExtras, messageJson, reactionsOfQuery } from "../api/shapes"
import { typesFilter } from "./users"

/** Top-level messages: thread replies stay in their thread unless broadcast. */
const IN_HISTORY = "(thread_ts IS NULL OR thread_ts = ts OR subtype = 'thread_broadcast')"

/** Unread counts stop here: counting reads every unread message, and a long-unread busy channel has thousands. */
export const MAX_UNREAD = 1000

async function unreadCount(ctx: Ctx<Actor>, c: ConversationRow, lastRead: string) {
  const row = await first<{ n: number }>(
    ctx.env.DB,
    `SELECT COUNT(*) AS n FROM (SELECT 1 FROM messages WHERE channel_id = ? AND ts > ? AND deleted = 0 AND ${IN_HISTORY}
     AND (user_id IS NULL OR user_id != ?) LIMIT ?)`,
    c.id,
    lastRead,
    ctx.auth.user.id,
    MAX_UNREAD,
  )
  return row?.n ?? 0
}

export async function conversationOut(ctx: Ctx<Actor>, c: ConversationRow, opts: { numMembers?: boolean } = {}) {
  const member = await actorMember(ctx, c)
  const numMembers = opts.numMembers
    ? ((await first<{ n: number }>(ctx.env.DB, "SELECT COUNT(*) AS n FROM members WHERE conversation_id = ?", c.id))
        ?.n ?? 0)
    : undefined
  return conversationJson(c, {
    member,
    unread: member ? await unreadCount(ctx, c, member.last_read) : undefined,
    numMembers,
    imUser: imPeer(c, ctx.auth.user.id),
  })
}

method("conversations.info", "actor", async (ctx) => {
  const c = await getConversation(ctx, ctx.args.req("channel", "channel_not_found"))
  await requireReadable(ctx, c)
  return { channel: await conversationOut(ctx, c, { numMembers: ctx.args.bool("include_num_members") }) }
})

method("conversations.list", "actor", async (ctx) => {
  const limit = ctx.args.int("limit", 100, { min: 1, max: 999 })
  const after = decodeCursor(ctx.args.str("cursor")) ?? ""
  const archived = ctx.args.bool("exclude_archived") ? "AND c.is_archived = 0" : ""
  // Public channels for everyone; private ones, DMs and group DMs only for their members.
  const rows = await all<ConversationRow & { last_read: string | null }>(
    ctx.env.DB,
    `SELECT c.*, m.last_read FROM conversations c
     LEFT JOIN members m ON m.conversation_id = c.id AND m.user_id = ?
     WHERE c.team_id = ? AND c.id > ? AND ${typesFilter(ctx, ctx.args.list("types"))} ${archived}
       AND ((c.kind = 'channel' AND c.is_private = 0) OR m.user_id IS NOT NULL)
     ORDER BY c.id LIMIT ?`,
    ctx.auth.user.id,
    ctx.auth.team.id,
    after,
    limit + 1,
  )
  const page = rows.slice(0, limit)
  return {
    channels: page.map((c) =>
      conversationJson(c, {
        member: c.last_read === null ? null : { last_read: c.last_read },
        imUser: imPeer(c, ctx.auth.user.id),
      }),
    ),
    response_metadata: { next_cursor: rows.length > limit ? encodeCursor(page.at(-1)!.id) : "" },
  }
})

async function messagesOut(ctx: Ctx<Actor>, rows: MessageRow[], reactions: D1Result) {
  const extras = await loadExtras(ctx.env, rows, reactions.results as ReactionRow[])
  return rows.map((m) => messageJson(m, extras, ctx.origin))
}

method("conversations.history", "actor", async (ctx) => {
  const c = await getConversation(ctx, ctx.args.req("channel", "channel_not_found"))
  await requireReadable(ctx, c)
  const limit = ctx.args.int("limit", 100, { min: 1, max: 999 })
  const inclusive = ctx.args.bool("inclusive")
  // The cursor continues below the last ts returned, so it wins over `latest`.
  const cursor = decodeCursor(ctx.args.str("cursor"))
  const latest = cursor ?? ctx.args.ts("latest")
  const oldest = ctx.args.ts("oldest")
  const conditions = ["channel_id = ?", "deleted = 0", IN_HISTORY]
  const params: unknown[] = [c.id]
  if (latest) {
    conditions.push(inclusive && !cursor ? "ts <= ?" : "ts < ?")
    params.push(latest)
  }
  if (oldest) {
    conditions.push(inclusive ? "ts >= ?" : "ts > ?")
    params.push(oldest)
  }
  // With only `oldest`, Slack pages forward from it; otherwise back from now/latest.
  const forward = Boolean(oldest && !latest)
  const db = ctx.env.DB
  const pageSql = `SELECT * FROM messages WHERE ${conditions.join(" AND ")} ORDER BY ts ${forward ? "ASC" : "DESC"} LIMIT ?`
  // The page and its reactions in one round trip.
  const [found, reactions] = await db.batch([
    stmt(db, pageSql, ...params, limit + 1),
    reactionsOfQuery(db, pageSql, ...params, limit + 1),
  ])
  const rows = found!.results as MessageRow[]
  const hasMore = rows.length > limit
  const page = rows.slice(0, limit)
  if (forward) page.reverse()
  return {
    messages: await messagesOut(ctx, page, reactions!),
    has_more: hasMore,
    pin_count: 0,
    channel_actions_ts: null,
    channel_actions_count: 0,
    response_metadata: { next_cursor: hasMore && !forward ? encodeCursor(page.at(-1)!.ts) : "" },
  }
})

method("conversations.replies", "actor", async (ctx) => {
  const c = await getConversation(ctx, ctx.args.req("channel", "channel_not_found"))
  await requireReadable(ctx, c)
  const ts = ctx.args.ts("ts")
  if (!ts) throw new CampflareError("thread_not_found")
  const limit = ctx.args.int("limit", 1000, { min: 1, max: 1000 })
  const after = decodeCursor(ctx.args.str("cursor"))
  const oldest = ctx.args.ts("oldest")
  const latest = ctx.args.ts("latest")
  const inclusive = ctx.args.bool("inclusive")
  const conditions = ["channel_id = ?", "thread_ts = ?", "deleted = 0"]
  const params: unknown[] = [c.id, ts]
  if (after) {
    conditions.push("ts > ?")
    params.push(after)
  }
  if (oldest) {
    conditions.push(inclusive ? "ts >= ?" : "ts > ?")
    params.push(oldest)
  }
  if (latest) {
    conditions.push(inclusive ? "ts <= ?" : "ts < ?")
    params.push(latest)
  }
  // The message, the page of its thread, and the reactions of both: one round trip. If the message
  // turns out to be a reply, its thread_ts isn't its own ts and the page comes back empty.
  const db = ctx.env.DB
  const messageSql = "SELECT * FROM messages WHERE channel_id = ? AND ts = ? AND deleted = 0"
  const pageSql = `SELECT * FROM messages WHERE ${conditions.join(" AND ")} ORDER BY ts ASC LIMIT ?`
  const [head, found, reactions] = await db.batch([
    stmt(db, messageSql, c.id, ts),
    stmt(db, pageSql, ...params, limit + 1),
    reactionsOfQuery(
      db,
      `SELECT channel_id, ts FROM (${messageSql}) UNION ALL SELECT channel_id, ts FROM (${pageSql})`,
      c.id,
      ts,
      ...params,
      limit + 1,
    ),
  ])
  const message = head!.results[0] as MessageRow | undefined
  if (!message) throw new CampflareError("message_not_found")
  // A reply's ts gives just that reply, as Slack does; a parent's gives the thread.
  if (!message.thread_ts || message.thread_ts !== message.ts) {
    return {
      messages: await messagesOut(ctx, [message], reactions!),
      has_more: false,
      response_metadata: { next_cursor: "" },
    }
  }
  const rows = found!.results as MessageRow[]
  const hasMore = rows.length > limit
  const page = rows.slice(0, limit)
  // The parent leads every page, as Slack returns it.
  if (page[0]?.ts !== ts) page.unshift(message)
  return {
    messages: await messagesOut(ctx, page, reactions!),
    has_more: hasMore,
    response_metadata: { next_cursor: hasMore ? encodeCursor(page.at(-1)!.ts) : "" },
  }
})

method("conversations.mark", "user", async (ctx) => {
  const c = await getConversation(ctx, ctx.args.req("channel", "channel_not_found"))
  await requireMember(ctx, c)
  const ts = ctx.args.ts("ts")
  if (!ts) throw new CampflareError("invalid_timestamp")
  await run(
    ctx.env.DB,
    "UPDATE members SET last_read = ? WHERE conversation_id = ? AND user_id = ?",
    ts,
    c.id,
    ctx.auth.user.id,
  )
  const type = c.kind === "im" ? "im_marked" : c.kind === "mpim" ? "group_marked" : "channel_marked"
  publish(ctx, {
    teamId: c.team_id,
    audience: [ctx.auth.user.id],
    rtmOnly: true,
    event: { type, channel: c.id, ts, unread_count: 0, unread_count_display: 0 },
  })
  return {}
})

method("conversations.open", "actor", async (ctx) => {
  let c: ConversationRow
  if (ctx.args.has("channel")) {
    c = await getConversation(ctx, ctx.args.req("channel"))
    await requireMember(ctx, c)
  } else {
    const users = ctx.args.list("users")
    if (users.length === 0) throw new CampflareError("users_list_not_supplied")
    c = await openConversation(ctx, users)
  }
  const full = ctx.args.bool("return_im")
  return {
    no_op: false,
    already_open: false,
    channel: full || c.kind === "mpim" ? await conversationOut(ctx, c) : { id: c.id },
  }
})

method("conversations.close", "actor", async (ctx) => {
  const c = await getConversation(ctx, ctx.args.req("channel", "channel_not_found"))
  if (c.kind === "channel") throw new CampflareError("method_not_supported_for_channel_type")
  await requireMember(ctx, c)
  // Closing hides a DM in Slack's sidebar; there is no sidebar state here yet.
  return { no_op: true, already_closed: true }
})

method("conversations.create", "actor", async (ctx) => {
  const name = validChannelName(ctx.args.req("name", "invalid_name_required"))
  const isPrivate = ctx.args.bool("is_private")
  const now = nowSeconds()
  const id = ids.channel()
  const self = ctx.auth.user
  try {
    await ctx.env.DB.batch([
      stmt(
        ctx.env.DB,
        `INSERT INTO conversations (id, team_id, kind, name, is_private, creator, created, updated)
         VALUES (?, ?, 'channel', ?, ?, ?, ?, ?)`,
        id,
        ctx.auth.team.id,
        name,
        isPrivate ? 1 : 0,
        self.id,
        now,
        now,
      ),
      stmt(ctx.env.DB, "INSERT INTO members (conversation_id, user_id, joined) VALUES (?, ?, ?)", id, self.id, now),
    ])
  } catch (error) {
    if (isUniqueViolation(error)) throw new CampflareError("name_taken")
    throw error
  }
  const c = await getConversation(ctx, id)
  if (!isPrivate) {
    publish(ctx, {
      teamId: c.team_id,
      audience: "team",
      event: { type: "channel_created", channel: { id, name, created: now, creator: self.id, is_channel: true } },
    })
  }
  return { channel: await conversationOut(ctx, c) }
})

async function joinMessage(ctx: Ctx<Actor>, c: ConversationRow, userId: string) {
  await postMessage(ctx, c, { user_id: userId, subtype: "channel_join", text: `<@${userId}> has joined the channel` })
}

method("conversations.join", "actor", async (ctx) => {
  const c = await getConversation(ctx, ctx.args.req("channel", "channel_not_found"))
  if (c.kind !== "channel") throw new CampflareError("method_not_supported_for_channel_type")
  if (c.is_private && !(await actorMember(ctx, c))) throw new CampflareError("channel_not_found")
  requireNotArchived(c)
  const joined = await addMember(ctx, c, ctx.auth.user.id)
  if (joined) await joinMessage(ctx, c, ctx.auth.user.id)
  return {
    channel: await conversationOut(ctx, c),
    ...(joined ? {} : { warning: "already_in_channel", response_metadata: { warnings: ["already_in_channel"] } }),
  }
})

method("conversations.leave", "actor", async (ctx) => {
  const c = await getConversation(ctx, ctx.args.req("channel", "channel_not_found"))
  if (c.kind === "im") throw new CampflareError("method_not_supported_for_channel_type")
  if (c.is_general) throw new CampflareError("cant_leave_general")
  if (!(await actorMember(ctx, c))) return { not_in_channel: true }
  await postMessage(ctx, c, {
    user_id: ctx.auth.user.id,
    subtype: "channel_leave",
    text: `<@${ctx.auth.user.id}> has left the channel`,
  })
  await removeMember(ctx, c, ctx.auth.user.id)
  return {}
})

method("conversations.invite", "actor", async (ctx) => {
  const c = await getConversation(ctx, ctx.args.req("channel", "channel_not_found"))
  if (c.kind !== "channel") throw new CampflareError("method_not_supported_for_channel_type")
  await requireMember(ctx, c)
  requireNotArchived(c)
  const users = ctx.args.list("users")
  if (users.length === 0) throw new CampflareError("no_user")
  if (users.includes(ctx.auth.user.id)) throw new CampflareError("cant_invite_self")
  const found = await all<UserRow>(
    ctx.env.DB,
    "SELECT * FROM users WHERE team_id = ? AND deleted = 0 AND id IN (SELECT value FROM json_each(?))",
    ctx.auth.team.id,
    JSON.stringify(users),
  )
  if (found.length !== users.length) throw new CampflareError("user_not_found")
  let added = 0
  for (const u of found) {
    if (await addMember(ctx, c, u.id, ctx.auth.user.id)) {
      added++
      await joinMessage(ctx, c, u.id)
    }
  }
  if (added === 0 && !ctx.args.bool("force")) throw new CampflareError("already_in_channel")
  return { channel: await conversationOut(ctx, c) }
})

method("conversations.kick", "actor", async (ctx) => {
  const c = await getConversation(ctx, ctx.args.req("channel", "channel_not_found"))
  if (c.kind !== "channel") throw new CampflareError("method_not_supported_for_channel_type")
  await requireMember(ctx, c)
  const user = ctx.args.req("user", "user_not_found")
  if (user === ctx.auth.user.id) throw new CampflareError("cant_kick_self")
  if (c.is_general) throw new CampflareError("cant_kick_from_general")
  if (!(await removeMember(ctx, c, user))) throw new CampflareError("not_in_channel")
  return {}
})

method("conversations.members", "actor", async (ctx) => {
  const c = await getConversation(ctx, ctx.args.req("channel", "channel_not_found"))
  await requireReadable(ctx, c)
  const limit = ctx.args.int("limit", 100, { min: 1, max: 1000 })
  const after = decodeCursor(ctx.args.str("cursor")) ?? ""
  const rows = await all<{ user_id: string }>(
    ctx.env.DB,
    "SELECT user_id FROM members WHERE conversation_id = ? AND user_id > ? ORDER BY user_id LIMIT ?",
    c.id,
    after,
    limit + 1,
  )
  const page = rows.slice(0, limit).map((r) => r.user_id)
  return { members: page, response_metadata: { next_cursor: rows.length > limit ? encodeCursor(page.at(-1)!) : "" } }
})

async function changeChannel(
  ctx: Ctx<Actor>,
  field: "topic" | "purpose",
  subtype: "channel_topic" | "channel_purpose",
) {
  const c = await getConversation(ctx, ctx.args.req("channel", "channel_not_found"))
  await requireMember(ctx, c)
  requireNotArchived(c)
  const value = ctx.args.str(field) ?? ""
  if (value.length > 250) throw new CampflareError("too_long")
  await run(
    ctx.env.DB,
    `UPDATE conversations SET ${field} = ?, ${field}_creator = ?, ${field}_last_set = ?, updated = ? WHERE id = ?`,
    value,
    ctx.auth.user.id,
    nowSeconds(),
    nowSeconds(),
    c.id,
  )
  const verb = field === "topic" ? "set the channel topic" : "set the channel description"
  await postMessage(ctx, c, {
    user_id: ctx.auth.user.id,
    subtype,
    text: value ? `${verb}: ${value}` : `cleared the channel ${field === "topic" ? "topic" : "description"}`,
  })
  return { channel: await conversationOut(ctx, await getConversation(ctx, c.id)) }
}

method("conversations.setTopic", "actor", (ctx) => changeChannel(ctx, "topic", "channel_topic"))
method("conversations.setPurpose", "actor", (ctx) => changeChannel(ctx, "purpose", "channel_purpose"))

method("conversations.rename", "actor", async (ctx) => {
  const c = await getConversation(ctx, ctx.args.req("channel", "channel_not_found"))
  if (c.kind !== "channel") throw new CampflareError("method_not_supported_for_channel_type")
  await requireMember(ctx, c)
  const name = validChannelName(ctx.args.req("name", "invalid_name_required"))
  if (name === c.name) return { channel: await conversationOut(ctx, c) }
  const previous = JSON.parse(c.previous_names) as string[]
  try {
    await run(
      ctx.env.DB,
      "UPDATE conversations SET name = ?, previous_names = ?, updated = ? WHERE id = ?",
      name,
      JSON.stringify([c.name, ...previous].slice(0, 10)),
      nowSeconds(),
      c.id,
    )
  } catch (error) {
    if (isUniqueViolation(error)) throw new CampflareError("name_taken")
    throw error
  }
  const renamed = await getConversation(ctx, c.id)
  publish(ctx, {
    teamId: c.team_id,
    audience: c.is_private ? await audienceOf(ctx, c.id) : "team",
    event: { type: "channel_rename", channel: { id: c.id, name, created: c.created, is_channel: true } },
  })
  await postMessage(ctx, renamed, {
    user_id: ctx.auth.user.id,
    subtype: "channel_name",
    text: `renamed the channel from "${c.name}" to "${name}"`,
  })
  return { channel: await conversationOut(ctx, renamed) }
})

async function setArchived(ctx: Ctx<Actor>, archived: boolean) {
  const c = await getConversation(ctx, ctx.args.req("channel", "channel_not_found"))
  if (c.kind !== "channel") throw new CampflareError("method_not_supported_for_channel_type")
  if (archived && c.is_general) throw new CampflareError("cant_archive_general")
  await requireReadable(ctx, c)
  if (Boolean(c.is_archived) === archived) throw new CampflareError(archived ? "already_archived" : "not_archived")
  await run(
    ctx.env.DB,
    "UPDATE conversations SET is_archived = ?, updated = ? WHERE id = ?",
    archived ? 1 : 0,
    nowSeconds(),
    c.id,
  )
  publish(ctx, {
    teamId: c.team_id,
    audience: c.is_private ? await audienceOf(ctx, c.id) : "team",
    event: { type: archived ? "channel_archive" : "channel_unarchive", channel: c.id, user: ctx.auth.user.id },
  })
  return {}
}

method("conversations.archive", "actor", (ctx) => setArchived(ctx, true))
method("conversations.unarchive", "actor", (ctx) => setArchived(ctx, false))
