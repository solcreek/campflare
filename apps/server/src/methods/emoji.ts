import { decodeCursor, encodeCursor } from "../api/args"
import { method, type Actor, type Ctx } from "../api/context"
import {
  EMOJI_CATEGORIES,
  EMOJI_MAX_BYTES,
  emojiImage,
  emojiKey,
  emojiValue,
  fetchEmojiImage,
  nameOf,
  newName,
  STANDARD_EMOJI,
  type EmojiImage,
} from "../api/emoji"
import { CampflareError } from "../api/errors"
import { nowSeconds, randomSecret } from "../api/ids"
import { all, isUniqueViolation, stmt } from "../db/query"
import type { EmojiRow } from "../db/rows"
import { publish } from "../events"

// Custom emoji: emoji.list as Slack's, Slack's admin.emoji.* (Enterprise
// there, any workspace here), and campflare.emoji.add for an upload, since
// admin.emoji.add takes a URL. Anyone may add an emoji or an alias (Slack's
// default); its creator or an admin may rename or remove it. Every change is
// emoji_changed to the whole workspace, as on Slack.

const cacheTs = (ms: number) => (ms / 1000).toFixed(6)

/** Bumps emoji.list's cache_ts, in the change's batch: when `name` is given, only if it's there by then. */
const touch = (ctx: Ctx<Actor>, now: number, name?: string) =>
  name === undefined
    ? stmt(ctx.env.DB, "UPDATE teams SET emoji_updated = ? WHERE id = ?", now, ctx.auth.team.id)
    : stmt(
        ctx.env.DB,
        "UPDATE teams SET emoji_updated = ? WHERE id = ? AND EXISTS (SELECT 1 FROM emoji WHERE team_id = ? AND name = ?)",
        now,
        ctx.auth.team.id,
        ctx.auth.team.id,
        name,
      )

function changed(ctx: Ctx<Actor>, event: Record<string, unknown>) {
  publish(ctx, { teamId: ctx.auth.team.id, event: { type: "emoji_changed", ...event }, audience: "team" })
}

method("emoji.list", "actor", async (ctx) => {
  const rows = await all<EmojiRow>(ctx.env.DB, "SELECT * FROM emoji WHERE team_id = ? ORDER BY name", ctx.auth.team.id)
  const emoji = Object.fromEntries(rows.map((e) => [e.name, emojiValue(ctx.origin, e)]))
  return {
    emoji,
    cache_ts: cacheTs(ctx.auth.team.emoji_updated),
    ...(ctx.args.bool("include_categories") ? { categories_version: "5", categories: EMOJI_CATEGORIES } : {}),
  }
})

/** Slack's Enterprise listing: each emoji with who added it and when, a page at a time by name. */
method("admin.emoji.list", "user", async (ctx) => {
  const limit = ctx.args.int("limit", 100, { min: 1, max: 1000 })
  const after = decodeCursor(ctx.args.str("cursor")) ?? ""
  const rows = await all<EmojiRow>(
    ctx.env.DB,
    "SELECT * FROM emoji WHERE team_id = ? AND name > ? ORDER BY name LIMIT ?",
    ctx.auth.team.id,
    after,
    limit + 1,
  )
  const page = rows.slice(0, limit)
  return {
    emoji: Object.fromEntries(
      page.map((e) => [
        e.name,
        {
          url: emojiValue(ctx.origin, e),
          date_created: e.created,
          uploaded_by: e.created_by,
          ...(e.alias_for !== null ? { alias_for: e.alias_for } : {}),
        },
      ]),
    ),
    response_metadata: { next_cursor: rows.length > limit ? encodeCursor(page.at(-1)!.name) : "" },
  }
})

/** Stores an image under a new name; a name taken by a custom emoji is error_name_taken. */
async function addImage(ctx: Ctx<Actor>, name: string, img: EmojiImage) {
  const image = randomSecret(8)
  const key = emojiKey(ctx.auth.team.id, image)
  await ctx.env.FILES.put(key, img.bytes, { httpMetadata: { contentType: img.type } })
  const now = Date.now()
  const row: EmojiRow = {
    team_id: ctx.auth.team.id,
    name,
    image,
    image_type: img.type,
    alias_for: null,
    created_by: ctx.auth.user.id,
    created: nowSeconds(),
  }
  try {
    await ctx.env.DB.batch([
      stmt(
        ctx.env.DB,
        `INSERT INTO emoji (team_id, name, image, image_type, created_by, created) VALUES (?, ?, ?, ?, ?, ?)`,
        row.team_id,
        name,
        image,
        img.type,
        row.created_by,
        row.created,
      ),
      touch(ctx, now),
    ])
  } catch (error) {
    ctx.waitUntil(ctx.env.FILES.delete(key))
    if (isUniqueViolation(error)) throw new CampflareError("error_name_taken")
    throw error
  }
  const value = emojiValue(ctx.origin, row)
  changed(ctx, { subtype: "add", name, value })
  return { name, url: value }
}

/** Slack's admin.emoji.add: an image from a URL, fetched through the SSRF guard. */
method("admin.emoji.add", "user", async (ctx) => {
  const name = newName(ctx.args.str("name"))
  const url = ctx.args.str("url")
  if (!url) throw new CampflareError("error_no_image")
  const added = await addImage(ctx, name, await emojiImage(ctx.env, await fetchEmojiImage(url)))
  return { emoji: added }
})

/** An emoji from an uploaded file (multipart `image`): what the CLI and the app use. */
method("campflare.emoji.add", "user", async (ctx) => {
  const name = newName(ctx.args.str("name"))
  const file = ctx.args.file("image")
  if (!file) throw new CampflareError("error_no_image")
  // Checked before reading: a client could send any size.
  if (file.size > EMOJI_MAX_BYTES) throw new CampflareError("error_too_big")
  const bytes = new Uint8Array(await file.arrayBuffer())
  return { emoji: await addImage(ctx, name, await emojiImage(ctx.env, bytes)) }
})

/**
 * Another name for an emoji: a custom one (an alias of an alias names the
 * original, as on Slack) or a standard one.
 */
method("admin.emoji.addAlias", "user", async (ctx) => {
  const name = newName(ctx.args.str("name"))
  const target = nameOf(ctx.args.str("alias_for"))
  if (!target) throw new CampflareError("emoji_not_found")
  const db = ctx.env.DB
  const team = ctx.auth.team.id
  const created = nowSeconds()
  const insert = STANDARD_EMOJI.has(target)
    ? stmt(
        db,
        "INSERT INTO emoji (team_id, name, alias_for, created_by, created) VALUES (?, ?, ?, ?, ?) RETURNING *",
        team,
        name,
        target,
        ctx.auth.user.id,
        created,
      )
    : stmt(
        db,
        `INSERT INTO emoji (team_id, name, alias_for, created_by, created)
         SELECT team_id, ?, COALESCE(alias_for, name), ?, ? FROM emoji WHERE team_id = ? AND name = ? RETURNING *`,
        name,
        ctx.auth.user.id,
        created,
        team,
        target,
      )
  let row: EmojiRow | undefined
  try {
    const [inserted] = await db.batch([insert, touch(ctx, Date.now(), name)])
    row = inserted!.results[0] as EmojiRow | undefined
  } catch (error) {
    if (isUniqueViolation(error)) throw new CampflareError("error_name_taken")
    throw error
  }
  if (!row) throw new CampflareError("emoji_not_found")
  const value = emojiValue(ctx.origin, row)
  changed(ctx, { subtype: "add", name, value })
  return { emoji: { name, url: value, alias_for: row.alias_for } }
})

/** Who may change an emoji: its creator, or an admin. As SQL over `emoji`, with its parameters. */
const mayChange = (ctx: Ctx<Actor>) => ({
  sql: "(created_by = ? OR ? = 1)",
  params: [ctx.auth.user.id, ctx.auth.user.is_admin ? 1 : 0],
})

/** Why nothing changed: the name isn't there, or the caller may not change it. */
function refused(before: EmojiRow | undefined): never {
  throw new CampflareError(before ? "not_an_admin" : "emoji_not_found")
}

/** Removes an emoji and, with an image, every alias of it, as Slack does. */
method("admin.emoji.remove", "user", async (ctx) => {
  const name = nameOf(ctx.args.str("name"))
  if (!name) throw new CampflareError("emoji_not_found")
  const db = ctx.env.DB
  const team = ctx.auth.team.id
  const may = mayChange(ctx)
  const [before, , aliases, removed] = await db.batch([
    stmt(db, "SELECT * FROM emoji WHERE team_id = ? AND name = ?", team, name),
    stmt(
      db,
      `UPDATE teams SET emoji_updated = ? WHERE id = ?
       AND EXISTS (SELECT 1 FROM emoji WHERE team_id = ? AND name = ? AND ${may.sql})`,
      Date.now(),
      team,
      team,
      name,
      ...may.params,
    ),
    // While the emoji is there to check: its aliases go with it.
    stmt(
      db,
      `DELETE FROM emoji WHERE team_id = ? AND alias_for = ?
       AND EXISTS (SELECT 1 FROM emoji WHERE team_id = ? AND name = ? AND ${may.sql}) RETURNING name`,
      team,
      name,
      team,
      name,
      ...may.params,
    ),
    stmt(db, `DELETE FROM emoji WHERE team_id = ? AND name = ? AND ${may.sql} RETURNING *`, team, name, ...may.params),
  ])
  const row = removed!.results[0] as EmojiRow | undefined
  if (!row) refused(before!.results[0] as EmojiRow | undefined)
  if (row.image) ctx.waitUntil(ctx.env.FILES.delete(emojiKey(team, row.image)))
  const names = [name, ...(aliases!.results as { name: string }[]).map((a) => a.name).toSorted()]
  changed(ctx, { subtype: "remove", names })
  return {}
})

/** Renames an emoji; its aliases follow it. Its image (and URL) stay. */
method("admin.emoji.rename", "user", async (ctx) => {
  const name = nameOf(ctx.args.str("name"))
  if (!name) throw new CampflareError("emoji_not_found")
  const to = newName(ctx.args.str("new_name"))
  const db = ctx.env.DB
  const team = ctx.auth.team.id
  const may = mayChange(ctx)
  let results: D1Result[]
  try {
    results = await db.batch([
      stmt(db, "SELECT * FROM emoji WHERE team_id = ? AND name = ?", team, name),
      // First, while the old name is there to check.
      stmt(
        db,
        `UPDATE emoji SET alias_for = ? WHERE team_id = ? AND alias_for = ?
         AND EXISTS (SELECT 1 FROM emoji WHERE team_id = ? AND name = ? AND ${may.sql})`,
        to,
        team,
        name,
        team,
        name,
        ...may.params,
      ),
      stmt(
        db,
        `UPDATE emoji SET name = ? WHERE team_id = ? AND name = ? AND ${may.sql} RETURNING *`,
        to,
        team,
        name,
        ...may.params,
      ),
      touch(ctx, Date.now(), to),
    ])
  } catch (error) {
    if (isUniqueViolation(error)) throw new CampflareError("error_name_taken")
    throw error
  }
  const row = results[2]!.results[0] as EmojiRow | undefined
  if (!row) refused(results[0]!.results[0] as EmojiRow | undefined)
  const value = emojiValue(ctx.origin, row)
  changed(ctx, { subtype: "rename", old_name: name, new_name: to, value })
  return { emoji: { name: to, url: value } }
})
