import { requireReadable, resolveConversation } from "../db/conversations"
import { requireMessage } from "../db/messages"
import { first, isUniqueViolation, run, stmt } from "../db/query"
import type { ConversationRow, FileRow, MessageRow, ReactionRow, StarRow } from "../db/rows"
import { starKey, unstarredItem } from "../db/stars"
import { publish } from "../events"
import { method, type Actor, type Ctx } from "../api/context"
import { decodeCursor, encodeCursor } from "../api/args"
import { CampflareError } from "../api/errors"
import { fileJson, loadExtras, messageJson, permalink, reactionsOfQuery, type MessageExtras } from "../api/shapes"
import { imagesOf } from "../api/thumbs"
import { canSee, getFile, readsOneOf } from "./files"

// Saved items, Slack's stars: a person's own list of messages, files and
// conversations. Nobody else sees it; the events go to the person alone.

/** What stars.add names, which the caller must be able to see: a message (channel + timestamp), a file, or a conversation. */
async function target(ctx: Ctx<Actor>) {
  if (ctx.args.has("file_comment")) throw new CampflareError("file_comment_not_found")
  const fileId = ctx.args.str("file")
  if (fileId) {
    const file = await getFile(ctx, fileId)
    if (!(await canSee(ctx.env, ctx.auth, file))) throw new CampflareError("file_not_found")
    return { type: "file" as const, key: starKey.file(file.id), file }
  }
  const channel = ctx.args.str("channel")
  if (!channel) throw new CampflareError("no_item_specified")
  const c = await resolveConversation(ctx, channel)
  await requireReadable(ctx, c)
  const ts = ctx.args.ts("timestamp")
  if (!ts) return { type: "channel" as const, key: starKey.channel(c.id), c }
  const message = await requireMessage(ctx, c.id, ts)
  return { type: "message" as const, key: starKey.message(c.id, message.ts), c, message }
}

type Target = Awaited<ReturnType<typeof target>>

/** Slack names a conversation star by its kind. */
function conversationType(c: Pick<ConversationRow, "kind" | "is_private">) {
  if (c.kind === "im") return "im"
  return c.kind === "mpim" || c.is_private ? "group" : "channel"
}

/** A saved message as stars.list and star_added carry it (star_removed's is unstarredItem()). */
const messageItem = (ctx: Ctx<Actor>, m: MessageRow, extras: MessageExtras, created: number) => ({
  type: "message",
  channel: m.channel_id,
  message: {
    ...messageJson(m, extras, ctx.origin),
    is_starred: true,
    permalink: permalink(ctx.origin, m.channel_id, m.ts, m.thread_ts),
  },
  date_create: created,
})

const fileItem = (ctx: Ctx<Actor>, f: FileRow, created: number) => ({
  type: "file",
  file: { ...fileJson(f, ctx.origin, Boolean(imagesOf(ctx.env))), is_starred: true },
  date_create: created,
})

async function itemJson(ctx: Ctx<Actor>, t: Target, created: number) {
  if (t.type === "file") return fileItem(ctx, t.file, created)
  if (t.type === "channel") return { type: conversationType(t.c), channel: t.c.id, date_create: created }
  return messageItem(ctx, t.message, await loadExtras(ctx.env, [t.message]), created)
}

const eventTs = () => `${(Date.now() / 1000).toFixed(6)}`

method("stars.add", "user", async (ctx) => {
  const t = await target(ctx)
  const user = ctx.auth.user.id
  const now = Math.floor(Date.now() / 1000)
  try {
    await run(
      ctx.env.DB,
      `INSERT INTO stars (user_id, item, team_id, type, channel_id, ts, file_id, created) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      user,
      t.key,
      ctx.auth.team.id,
      t.type,
      t.type === "file" ? null : t.c.id,
      t.type === "message" ? t.message.ts : null,
      t.type === "file" ? t.file.id : null,
      now,
    )
  } catch (error) {
    if (isUniqueViolation(error)) throw new CampflareError("already_starred")
    throw error
  }
  // The event's item (a message's reactions and files) is read after the response.
  const ts = eventTs()
  ctx.waitUntil(
    itemJson(ctx, t, now).then((item) =>
      publish(ctx, {
        teamId: ctx.auth.team.id,
        audience: [user],
        event: { type: "star_added", user, item, event_ts: ts },
      }),
    ),
  )
  return {}
})

/**
 * The key of the star stars.remove names. Removing touches only the caller's
 * own row, so it needs no access to the item: someone who lost access to a
 * conversation or file can still clear their star on it. Whatever doesn't
 * name a star of theirs is not_starred.
 */
async function removalKey(ctx: Ctx<Actor>): Promise<{ key: string; kind?: string }> {
  if (ctx.args.has("file_comment")) throw new CampflareError("file_comment_not_found")
  const fileId = ctx.args.str("file")
  if (fileId) return { key: starKey.file(fileId) }
  const channel = ctx.args.str("channel")
  if (!channel) throw new CampflareError("no_item_specified")
  let c: ConversationRow
  try {
    c = await resolveConversation(ctx, channel)
  } catch (error) {
    if (error instanceof CampflareError && error.code === "channel_not_found") throw new CampflareError("not_starred")
    throw error
  }
  const ts = ctx.args.ts("timestamp")
  return ts ? { key: starKey.message(c.id, ts) } : { key: starKey.channel(c.id), kind: conversationType(c) }
}

method("stars.remove", "user", async (ctx) => {
  const { key, kind } = await removalKey(ctx)
  const user = ctx.auth.user.id
  const removed = await first<StarRow>(
    ctx.env.DB,
    "DELETE FROM stars WHERE user_id = ? AND item = ? RETURNING *",
    user,
    key,
  )
  if (!removed) throw new CampflareError("not_starred")
  publish(ctx, {
    teamId: ctx.auth.team.id,
    audience: [user],
    event: { type: "star_removed", user, item: unstarredItem(removed, kind), event_ts: eventTs() },
  })
  return {}
})

/**
 * The person's stars they can still see, newest first: a conversation they
 * left, or a file no longer shared with them, drops out (and comes back if
 * they regain it). The rules are files.list's (readsOneOf()); ?1 is the user.
 */
const VISIBLE = `s.user_id = ?1
  AND (s.channel_id IS NULL OR ${readsOneOf("json_array(s.channel_id)", "?1")})
  AND (s.file_id IS NULL OR EXISTS (SELECT 1 FROM files WHERE files.id = s.file_id
    AND (files.user_id = ?1 OR ${readsOneOf("files.channels", "?1")})))`

type ListedStar = StarRow & { c_kind: ConversationRow["kind"] | null; c_private: number | null }

method("stars.list", "user", async (ctx) => {
  // Slack pages by count and page, and by limit and cursor; both work here.
  const limit = ctx.args.int("limit", ctx.args.int("count", 100), { min: 1, max: 1000 })
  const page = ctx.args.int("page", 1, { min: 1 })
  const cursor = decodeCursor(ctx.args.str("cursor"))
  const after = cursor ? cursor.split("|") : undefined
  const db = ctx.env.DB
  const user = ctx.auth.user.id
  // Position: (created, item), newest first.
  const position = after ? "AND (s.created < ?2 OR (s.created = ?2 AND s.item > ?3))" : ""
  // The page and the total first: the visibility rule runs once for each.
  const [found, total] = await db.batch([
    stmt(
      db,
      `SELECT s.*, conv.kind AS c_kind, conv.is_private AS c_private FROM stars s
       LEFT JOIN conversations conv ON conv.id = s.channel_id WHERE ${VISIBLE} ${position}
       ORDER BY s.created DESC, s.item LIMIT ? OFFSET ?`,
      ...(after ? [user, Number(after[0]), after[1]] : [user]),
      limit + 1,
      after ? 0 : (page - 1) * limit,
    ),
    stmt(db, `SELECT COUNT(*) AS n FROM stars s WHERE ${VISIBLE}`, user),
  ])
  const rows = (found!.results as ListedStar[]).slice(0, limit)
  const hasMore = found!.results.length > limit
  // Then what the page names, by id: its messages with their reactions, and its files.
  const pairs = JSON.stringify(rows.filter((r) => r.type === "message").map((r) => [r.channel_id, r.ts]))
  const fileIds = JSON.stringify(rows.filter((r) => r.type === "file").map((r) => r.file_id))
  const pairsSql = "SELECT value ->> 0 AS channel_id, value ->> 1 AS ts FROM json_each(?)"
  const [messages, reactions, files] = rows.length
    ? await db.batch([
        stmt(db, `SELECT * FROM messages WHERE (channel_id, ts) IN (${pairsSql}) AND deleted = 0`, pairs),
        reactionsOfQuery(db, pairsSql, pairs),
        stmt(db, "SELECT * FROM files WHERE id IN (SELECT value FROM json_each(?))", fileIds),
      ])
    : []
  const messageRows = (messages?.results ?? []) as MessageRow[]
  const extras = await loadExtras(ctx.env, messageRows, (reactions?.results ?? []) as ReactionRow[])
  const messageOf = new Map(messageRows.map((m) => [starKey.message(m.channel_id, m.ts), m]))
  const fileOf = new Map(((files?.results ?? []) as FileRow[]).map((f) => [f.id, f]))
  const items = rows.flatMap((s): object[] => {
    if (s.type === "message") {
      const m = messageOf.get(s.item)
      return m ? [messageItem(ctx, m, extras, s.created)] : []
    }
    if (s.type === "file") {
      const f = fileOf.get(s.file_id!)
      return f ? [fileItem(ctx, f, s.created)] : []
    }
    const type = conversationType({ kind: s.c_kind ?? "channel", is_private: s.c_private ?? 0 })
    return [{ type, channel: s.channel_id, date_create: s.created }]
  })
  const count = (total!.results[0] as { n: number }).n
  const last = rows.at(-1)
  return {
    items,
    paging: {
      per_page: limit,
      spill: 0,
      page: after ? 1 : page,
      total: count,
      pages: Math.max(1, Math.ceil(count / limit)),
    },
    response_metadata: { next_cursor: hasMore && last ? encodeCursor(`${last.created}|${last.item}`) : "" },
  }
})
