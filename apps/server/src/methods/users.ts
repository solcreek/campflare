import { encodeCursor, decodeCursor } from "../api/args"
import { all, first, run } from "../db/query"
import type { ConversationRow, MemberRow, UserRow } from "../db/rows"
import { conversationJson, presenceOf, userJson } from "../api/shapes"
import { method, type Actor, type Ctx } from "../api/context"
import { CampflareError, invalidArguments } from "../api/errors"
import { requireConversationScope } from "../api/scopes"
import { imPeer } from "../db/conversations"
import { nowSeconds, randomSecret } from "../api/ids"
import { displaySize, imageSize, isAnimated } from "../api/media"
import { photoKeys, photoPrefix, photoType, type Crop } from "../api/photos"
import { userChanged } from "../events"

export async function getUser(ctx: Ctx<Actor>, id: string) {
  const user = await first<UserRow>(
    ctx.env.DB,
    "SELECT * FROM users WHERE id = ? AND team_id = ?",
    id,
    ctx.auth.team.id,
  )
  if (!user) throw new CampflareError("user_not_found")
  return user
}

method("users.info", "actor", async (ctx) => {
  const user = await getUser(ctx, ctx.args.req("user", "user_not_found"))
  return { user: userJson(user, ctx.origin) }
})

method("users.list", "actor", async (ctx) => {
  const limit = ctx.args.int("limit", 0, { min: 0, max: 1000 }) || 1000
  const after = decodeCursor(ctx.args.str("cursor")) ?? ""
  const rows = await all<UserRow>(
    ctx.env.DB,
    "SELECT * FROM users WHERE team_id = ? AND id > ? ORDER BY id LIMIT ?",
    ctx.auth.team.id,
    after,
    limit + 1,
  )
  const page = rows.slice(0, limit)
  return {
    members: page.map((u) => userJson(u, ctx.origin)),
    cache_ts: nowSeconds(),
    response_metadata: { next_cursor: rows.length > limit ? encodeCursor(page.at(-1)!.id) : "" },
  }
})

method("users.lookupByEmail", "actor", async (ctx) => {
  const user = await first<UserRow>(
    ctx.env.DB,
    "SELECT * FROM users WHERE team_id = ? AND email = ? AND deleted = 0",
    ctx.auth.team.id,
    ctx.args.req("email").toLowerCase(),
  )
  if (!user) throw new CampflareError("users_not_found")
  return { user: userJson(user, ctx.origin) }
})

method("users.getPresence", "actor", async (ctx) => {
  const user = ctx.args.has("user") ? await getUser(ctx, ctx.args.req("user")) : ctx.auth.user
  const hub = ctx.env.HUB.get(ctx.env.HUB.idFromName(ctx.auth.team.id))
  // A live RTM connection counts as active, as a Slack client does; else recent API use.
  const online = user.manual_presence !== "away" && (await hub.online([user.id])).length > 0
  const presence = online ? "active" : presenceOf(user)
  return {
    presence,
    ...(user.id === ctx.auth.user.id
      ? {
          online: presence === "active",
          auto_away: false,
          manual_away: user.manual_presence === "away",
          connection_count: 0,
          last_activity: user.last_activity,
        }
      : {}),
  }
})

method("users.setPresence", "user", async (ctx) => {
  const presence = ctx.args.req("presence")
  if (presence !== "auto" && presence !== "away") throw new CampflareError("invalid_presence")
  await run(ctx.env.DB, "UPDATE users SET manual_presence = ? WHERE id = ?", presence, ctx.auth.user.id)
  return {}
})

method("users.profile.get", "actor", async (ctx) => {
  const user = ctx.args.has("user") ? await getUser(ctx, ctx.args.req("user")) : ctx.auth.user
  return { profile: userJson(user, ctx.origin).profile }
})

const PROFILE_FIELDS: Record<string, keyof UserRow> = {
  real_name: "real_name",
  display_name: "display_name",
  title: "title",
  status_text: "status_text",
  status_emoji: "status_emoji",
  status_expiration: "status_expiration",
}

method("users.profile.set", "user", async (ctx) => {
  const changes: Record<string, unknown> = { ...ctx.args.json<Record<string, unknown>>("profile") }
  const name = ctx.args.str("name")
  if (name) changes[name] = ctx.args.str("value") ?? ""
  const sets = Object.entries(changes).filter(([k]) => k in PROFILE_FIELDS)
  if (sets.length === 0) throw new CampflareError("invalid_profile")
  const user = (await first<UserRow>(
    ctx.env.DB,
    `UPDATE users SET ${sets.map(([k]) => `${PROFILE_FIELDS[k]} = ?`).join(", ")}, updated = ? WHERE id = ? RETURNING *`,
    ...sets.map(([k, v]) => (k === "status_expiration" ? Number(v) || 0 : String(v ?? ""))),
    nowSeconds(),
    ctx.auth.user.id,
  ))!
  userChanged(ctx, user)
  return { profile: userJson(user, ctx.origin).profile }
})

/** Photos up to this many bytes, and pixels on a side. */
const PHOTO_MAX_BYTES = 10 * 1024 * 1024
const PHOTO_MAX_SIDE = 8192

/** The crop square users.setPhoto was given (crop_x, crop_y, crop_w), checked against the image as shown (upright); else null. */
function cropOf(ctx: Ctx<Actor>, size: { width: number; height: number }): Crop | null {
  if (!ctx.args.has("crop_w")) return null
  const crop = { x: ctx.args.int("crop_x", 0), y: ctx.args.int("crop_y", 0), w: ctx.args.int("crop_w", 0) }
  if (crop.x < 0 || crop.y < 0 || crop.w < 1 || crop.x + crop.w > size.width || crop.y + crop.w > size.height) {
    throw invalidArguments("the crop square (crop_x, crop_y, crop_w) must lie inside the image")
  }
  return crop
}

/** Forgets a photo's bytes, its sizes too, after the response. */
function dropPhoto(ctx: Ctx<Actor>, photo: string | null) {
  if (photo) ctx.waitUntil(ctx.env.FILES.delete(photoKeys(ctx.auth.user, photo)))
}

/**
 * Sets the caller's profile photo from a multipart `image` (PNG, JPEG, WebP, or a still GIF),
 * optionally cropped to the square crop_w wide at crop_x, crop_y. The sizes are made on first
 * fetch (photos.ts). The new photo has new URLs, so clients showing the old one refetch.
 */
method("users.setPhoto", "user", async (ctx) => {
  const image = ctx.args.file("image")
  if (!image) throw new CampflareError("bad_image")
  if (image.size > PHOTO_MAX_BYTES) throw new CampflareError("too_large")
  const bytes = new Uint8Array(await image.arrayBuffer())
  const size = imageSize(bytes)
  const type = size && photoType(bytes)
  if (!size || !type || !size.width || !size.height) throw new CampflareError("bad_image")
  if (Math.max(size.width, size.height) > PHOTO_MAX_SIDE) throw new CampflareError("too_large")
  if (isAnimated(bytes)) throw new CampflareError("too_many_frames")
  // In the coordinates people (and the Images binding, which turns the photo upright) see.
  const crop = cropOf(ctx, displaySize(bytes, size))
  const photo = randomSecret(8)
  const me = ctx.auth.user
  await ctx.env.FILES.put(`${photoPrefix(me, photo)}original`, bytes, { httpMetadata: { contentType: type } })
  const user = (await first<UserRow>(
    ctx.env.DB,
    "UPDATE users SET photo = ?, photo_type = ?, photo_crop = ?, updated = ? WHERE id = ? RETURNING *",
    photo,
    type,
    crop ? JSON.stringify(crop) : null,
    nowSeconds(),
    me.id,
  ))!
  dropPhoto(ctx, me.photo)
  userChanged(ctx, user)
  return { profile: userJson(user, ctx.origin).profile }
})

/** Removes the caller's photo: the profile shows their initials again. */
method("users.deletePhoto", "user", async (ctx) => {
  const me = ctx.auth.user
  if (!me.photo) return {}
  const user = (await first<UserRow>(
    ctx.env.DB,
    "UPDATE users SET photo = NULL, photo_type = NULL, photo_crop = NULL, updated = ? WHERE id = ? RETURNING *",
    nowSeconds(),
    me.id,
  ))!
  dropPhoto(ctx, me.photo)
  userChanged(ctx, user)
  return {}
})

/** Each `types` value: its SQL, and the kind of conversation whose :read scope it wants. */
const TYPE_FILTERS: Record<string, { sql: string; kind: Pick<ConversationRow, "kind" | "is_private"> }> = {
  public_channel: { sql: "(c.kind = 'channel' AND c.is_private = 0)", kind: { kind: "channel", is_private: 0 } },
  private_channel: { sql: "(c.kind = 'channel' AND c.is_private = 1)", kind: { kind: "channel", is_private: 1 } },
  mpim: { sql: "c.kind = 'mpim'", kind: { kind: "mpim", is_private: 1 } },
  im: { sql: "c.kind = 'im'", kind: { kind: "im", is_private: 1 } },
}

/**
 * The SQL filter for a `types` argument (default: public channels, as Slack).
 * Each type asked for needs its :read scope, as on Slack.
 */
export function typesFilter(ctx: Ctx<Actor>, types: string[]): string {
  const filters = (types.length ? types : ["public_channel"]).map((t) => {
    const f = TYPE_FILTERS[t]
    if (!f) throw new CampflareError("invalid_types")
    requireConversationScope(ctx.auth, f.kind, "read")
    return f.sql
  })
  return `(${filters.join(" OR ")})`
}

method("users.conversations", "actor", async (ctx) => {
  const user = ctx.args.has("user") ? await getUser(ctx, ctx.args.req("user")) : ctx.auth.user
  const limit = ctx.args.int("limit", 100, { min: 1, max: 999 })
  const after = decodeCursor(ctx.args.str("cursor")) ?? ""
  const archived = ctx.args.bool("exclude_archived") ? "AND c.is_archived = 0" : ""
  const rows = await all<ConversationRow & Pick<MemberRow, "last_read">>(
    ctx.env.DB,
    `SELECT c.*, m.last_read FROM members m JOIN conversations c ON c.id = m.conversation_id
     WHERE m.user_id = ? AND c.team_id = ? AND c.id > ? AND ${typesFilter(ctx, ctx.args.list("types"))} ${archived}
     ORDER BY c.id LIMIT ?`,
    user.id,
    ctx.auth.team.id,
    after,
    limit + 1,
  )
  const page = rows.slice(0, limit)
  const self = user.id === ctx.auth.user.id
  return {
    channels: page.map((c) =>
      conversationJson(c, {
        member: self ? { last_read: c.last_read } : { last_read: "" },
        imUser: imPeer(c, user.id),
      }),
    ),
    response_metadata: { next_cursor: rows.length > limit ? encodeCursor(page.at(-1)!.id) : "" },
  }
})
