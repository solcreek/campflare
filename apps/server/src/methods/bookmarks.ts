import { requireMember, requireNotArchived, requireReadable, resolveConversation } from "../db/conversations"
import { all, stmt } from "../db/query"
import type { BookmarkRow, ConversationRow } from "../db/rows"
import { audienceFrom, audienceStatement, publish } from "../events"
import { method, type Actor, type Ctx } from "../api/context"
import { CampflareError, invalidArguments } from "../api/errors"
import { randomId } from "../api/ids"

// A conversation's bookmarks bar: links, in the order they were added.

/** As on Slack, a conversation holds at most this many (too_many_bookmarks). */
export const MAX_BOOKMARKS = 100
const MAX_TITLE = 256
const MAX_LINK = 2048

export function bookmarkJson(b: BookmarkRow) {
  return {
    id: b.id,
    channel_id: b.channel_id,
    title: b.title,
    link: b.link,
    emoji: b.emoji,
    icon_url: null,
    type: "link",
    entity_id: b.entity_id,
    date_created: b.date_created,
    date_updated: b.date_updated,
    rank: b.rank,
    last_updated_by_user_id: b.updated_by,
    last_updated_by_team_id: b.team_id,
    shortcut_id: null,
    app_id: b.app_id,
    app_action_id: null,
  }
}

/** The conversation `channel_id` names, readable by the caller; a change also wants a member and no archive. */
async function conversationOf(ctx: Ctx<Actor>, change: boolean) {
  const c = await resolveConversation(ctx, ctx.args.req("channel_id", "channel_not_found"))
  if (change) {
    await requireMember(ctx, c)
    requireNotArchived(c)
  } else await requireReadable(ctx, c)
  return c
}

/** Only http(s) links, so a click can't run script or open a local file. */
function validLink(raw: string): string {
  const link = raw.trim()
  let url: URL
  try {
    url = new URL(link)
  } catch {
    throw new CampflareError("invalid_link")
  }
  if ((url.protocol !== "http:" && url.protocol !== "https:") || link.length > MAX_LINK) {
    throw new CampflareError("invalid_link")
  }
  return link
}

function validTitle(raw: string): string {
  const title = raw.trim()
  if (!title) throw invalidArguments("missing required field: title")
  if (title.length > MAX_TITLE) throw invalidArguments(`title must be at most ${MAX_TITLE} characters`)
  return title
}

/** ":rocket:" or "rocket" → ":rocket:"; "" clears it. */
function validEmoji(raw: string): string {
  if (!raw) return ""
  const name = raw.replace(/^:/, "").replace(/:$/, "").toLowerCase()
  if (!/^[a-z0-9_+'-]+(::skin-tone-[2-6])?$/.test(name) || name.length > 100) throw new CampflareError("invalid_emoji")
  return `:${name}:`
}

function announce(ctx: Ctx<Actor>, c: ConversationRow, type: string, audience: D1Result, b: BookmarkRow) {
  publish(ctx, {
    teamId: c.team_id,
    audience: audienceFrom(audience),
    event: { type, channel_id: c.id, bookmark: bookmarkJson(b), event_ts: `${(Date.now() / 1000).toFixed(6)}` },
  })
}

method("bookmarks.add", "actor", async (ctx) => {
  const c = await conversationOf(ctx, true)
  const type = ctx.args.req("type")
  if (type !== "link") throw new CampflareError("invalid_bookmark_type")
  const title = validTitle(ctx.args.req("title"))
  const link = validLink(ctx.args.req("link", "invalid_link"))
  const emoji = validEmoji(ctx.args.str("emoji") ?? "")
  const id = randomId("Bk")
  const now = Math.floor(Date.now() / 1000)
  const db = ctx.env.DB
  // Ranked after the last one, unless the bar is full; the row and the audience in the same trip.
  const [inserted, row, audience] = await db.batch([
    stmt(
      db,
      `INSERT INTO bookmarks (id, team_id, channel_id, title, link, emoji, entity_id, app_id, rank, created_by,
         updated_by, date_created)
       SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8,
         printf('%010d', COALESCE((SELECT MAX(CAST(rank AS INTEGER)) FROM bookmarks WHERE channel_id = ?3), 0) + 1),
         ?9, ?9, ?10
       WHERE (SELECT COUNT(*) FROM bookmarks WHERE channel_id = ?3) < ?11`,
      id,
      c.team_id,
      c.id,
      title,
      link,
      emoji,
      ctx.args.str("entity_id") ?? null,
      ctx.auth.app?.id ?? null,
      ctx.auth.user.id,
      now,
      MAX_BOOKMARKS,
    ),
    stmt(db, "SELECT * FROM bookmarks WHERE id = ?", id),
    audienceStatement(db, c.id),
  ])
  if (!inserted!.meta.changes) throw new CampflareError("too_many_bookmarks")
  const bookmark = row!.results[0] as BookmarkRow
  announce(ctx, c, "bookmark_added", audience!, bookmark)
  return { bookmark: bookmarkJson(bookmark) }
})

method("bookmarks.edit", "actor", async (ctx) => {
  const c = await conversationOf(ctx, true)
  const id = ctx.args.req("bookmark_id", "not_found")
  const title = ctx.args.has("title") ? validTitle(ctx.args.req("title")) : null
  const link = ctx.args.has("link") ? validLink(ctx.args.req("link")) : null
  const emoji = ctx.args.given("emoji") ? validEmoji(ctx.args.str("emoji") ?? "") : null
  const db = ctx.env.DB
  const [updated, row, audience] = await db.batch([
    stmt(
      db,
      `UPDATE bookmarks SET title = COALESCE(?, title), link = COALESCE(?, link), emoji = COALESCE(?, emoji),
         updated_by = ?, date_updated = ?
       WHERE id = ? AND channel_id = ?`,
      title,
      link,
      emoji,
      ctx.auth.user.id,
      Math.floor(Date.now() / 1000),
      id,
      c.id,
    ),
    stmt(db, "SELECT * FROM bookmarks WHERE id = ? AND channel_id = ?", id, c.id),
    audienceStatement(db, c.id),
  ])
  if (!updated!.meta.changes) throw new CampflareError("not_found")
  const bookmark = row!.results[0] as BookmarkRow
  announce(ctx, c, "bookmark_changed", audience!, bookmark)
  return { bookmark: bookmarkJson(bookmark) }
})

method("bookmarks.remove", "actor", async (ctx) => {
  const c = await conversationOf(ctx, true)
  const id = ctx.args.req("bookmark_id", "not_found")
  const db = ctx.env.DB
  // The row goes, and comes back for the event, in one statement.
  const [removed, audience] = await db.batch([
    stmt(db, "DELETE FROM bookmarks WHERE id = ? AND channel_id = ? RETURNING *", id, c.id),
    audienceStatement(db, c.id),
  ])
  const bookmark = removed!.results[0] as BookmarkRow | undefined
  if (!bookmark) throw new CampflareError("not_found")
  announce(ctx, c, "bookmark_removed", audience!, bookmark)
  return {}
})

method("bookmarks.list", "actor", async (ctx) => {
  const c = await conversationOf(ctx, false)
  const rows = await all<BookmarkRow>(ctx.env.DB, "SELECT * FROM bookmarks WHERE channel_id = ? ORDER BY rank", c.id)
  return { bookmarks: rows.map(bookmarkJson) }
})
