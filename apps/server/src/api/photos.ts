import { first } from "../db/query"
import type { UserRow } from "../db/rows"
import type { Env } from "../env"
import { imagesOf } from "./thumbs"

// Profile photos (users.setPhoto): the original in R2 at
// <team>/avatars/<user>/<photo>/original, and Slack's square sizes (image_24 …
// image_1024) made from it by the Images binding on first fetch, kept beside it.
// Without the binding every size is the original.
//
// URLs carry no token, as the initials (/avatars/:id) don't: <img src> can't
// send one, and Slack's own avatar URLs are public too. A photo's id is random
// (unguessable) and changes with every new photo, so a URL names one photo for
// good: served immutable, and a client refetches because the URL changed.

/** Slack's profile image sizes: image_24 … image_1024, squares. */
export const PHOTO_SIZES = [24, 32, 48, 72, 192, 512, 1024] as const

/** What a photo may be. GIFs are taken as stills (a moving one is refused); SVG never. */
export const PHOTO_TYPES: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
}

/** A photo's type, from its first bytes (never the name or the client's word); undefined if it's none of PHOTO_TYPES. */
export function photoType(b: Uint8Array): string | undefined {
  const ascii = (i: number, n: number) => String.fromCharCode(...b.subarray(i, i + n))
  if (b[0] === 0x89 && ascii(1, 3) === "PNG") return "image/png"
  if (b[0] === 0xff && b[1] === 0xd8) return "image/jpeg"
  if (ascii(0, 3) === "GIF") return "image/gif"
  if (ascii(0, 4) === "RIFF" && ascii(8, 4) === "WEBP") return "image/webp"
  return undefined
}

export interface Crop {
  x: number
  y: number
  w: number
}

type WithPhoto = Pick<UserRow, "id" | "team_id" | "photo" | "photo_type" | "photo_crop">

export const photoPrefix = (u: Pick<UserRow, "id" | "team_id">, photo: string) =>
  `${u.team_id}/avatars/${u.id}/${photo}/`

/**
 * Deletes everything R2 holds under a photo's prefix: the original and whatever sizes were
 * made. Callers change users.photo first; handlePhoto checks it after each write, so a size
 * made while this runs is deleted by one or the other.
 */
export async function dropPhoto(env: Pick<Env, "FILES">, u: Pick<UserRow, "id" | "team_id">, photo: string) {
  const prefix = photoPrefix(u, photo)
  let cursor: string | undefined
  do {
    const page = await env.FILES.list({ prefix, cursor })
    if (page.objects.length) await env.FILES.delete(page.objects.map((o) => o.key))
    cursor = page.truncated ? page.cursor : undefined
  } while (cursor)
}

/** JPEG stays JPEG, the rest become PNG (transparency kept), as thumbnails do. */
const sizedFormat = (type: string) =>
  type === "image/jpeg" ? { type: "image/jpeg" as const, ext: "jpg" } : { type: "image/png" as const, ext: "png" }

/** The profile's image_* fields for a person with a photo, else undefined. */
export function photoJson(origin: string, u: WithPhoto): Record<string, string | boolean> | undefined {
  if (!u.photo || !u.photo_type) return undefined
  const base = `${origin}/avatars/${u.id}/${u.photo}_`
  const { ext } = sizedFormat(u.photo_type)
  const json: Record<string, string | boolean> = { is_custom_image: true }
  for (const n of PHOTO_SIZES) json[`image_${n}`] = `${base}${n}.${ext}`
  json.image_original = `${base}original.${PHOTO_TYPES[u.photo_type] ?? "img"}`
  return json
}

/** The size a photo URL's name asks for ("<photo>_<size>.<ext>"), "original", or undefined. */
export function photoVariantOf(u: WithPhoto, name: string): number | "original" | undefined {
  if (!u.photo || !u.photo_type || !name.startsWith(`${u.photo}_`)) return undefined
  const rest = name.slice(u.photo.length + 1)
  if (rest === `original.${PHOTO_TYPES[u.photo_type]}`) return "original"
  const [, digits, ext] = /^(\d+)\.(png|jpg)$/.exec(rest) ?? []
  const size = Number(digits)
  return (PHOTO_SIZES as readonly number[]).includes(size) && ext === sizedFormat(u.photo_type).ext ? size : undefined
}

/**
 * The transformations that make one size: the crop square if there is one, then a square of n.
 * The crop is in the photo's upright coordinates (users.setPhoto checks it against the size
 * after a JPEG's EXIF orientation), as Images turns a photo upright before transforming it.
 */
export function photoTransforms(crop: Crop | null, size: number): ImageTransform[] {
  const square: ImageTransform = { width: size, height: size, fit: "cover" }
  return crop ? [{ trim: { left: crop.x, top: crop.y, width: crop.w, height: crop.w } }, square] : [square]
}

const IMMUTABLE = "public, max-age=31536000, immutable"

function serve(body: R2ObjectBody | ArrayBuffer, type: string, cache: string) {
  return new Response(body instanceof ArrayBuffer ? body : body.body, {
    headers: {
      "content-type": type,
      "cache-control": cache,
      ...(body instanceof ArrayBuffer ? {} : { etag: body.httpEtag }),
      // Bytes someone uploaded: never run as this origin's content.
      "content-security-policy": "sandbox",
      "x-content-type-options": "nosniff",
    },
  })
}

/**
 * GET /avatars/<user>/<photo>_<size>.<ext>: one size of a person's photo, made on its first
 * fetch. If the Images binding is off or fails on the photo, the original is served instead,
 * cached briefly, so the next fetch tries again.
 */
export async function handlePhoto(env: Env, userId: string, name: string): Promise<Response> {
  const notFound = new Response("not found", { status: 404 })
  const u = await first<WithPhoto>(
    env.DB,
    "SELECT id, team_id, photo, photo_type, photo_crop FROM users WHERE id = ?",
    userId,
  )
  const variant = u ? photoVariantOf(u, name) : undefined
  if (!u || !variant) return notFound
  const prefix = photoPrefix(u, u.photo!)
  const original = () => env.FILES.get(`${prefix}original`)
  const fallback = async () => {
    const o = await original()
    return o ? serve(o, u.photo_type!, "public, max-age=300") : notFound
  }
  if (variant === "original") {
    const o = await original()
    return o ? serve(o, u.photo_type!, IMMUTABLE) : notFound
  }
  const { type } = sizedFormat(u.photo_type!)
  const cached = await env.FILES.get(`${prefix}${variant}`)
  if (cached) return serve(cached, type, IMMUTABLE)
  const images = imagesOf(env)
  if (!images) return fallback()
  const source = await original()
  if (!source) return notFound
  let bytes: ArrayBuffer
  try {
    let input = images.input(source.body)
    const crop = u.photo_crop ? (JSON.parse(u.photo_crop) as Crop) : null
    for (const t of photoTransforms(crop, variant)) input = input.transform(t)
    const out = await input.output({ format: type, anim: false })
    bytes = await out.response().arrayBuffer()
  } catch (error) {
    console.error(`photo ${variant} of ${u.id} failed`, error)
    return fallback()
  }
  await env.FILES.put(`${prefix}${variant}`, bytes, { httpMetadata: { contentType: type } })
  // A new photo, or none, may have landed while this one was sized: then its dropPhoto may
  // have listed the prefix before this write, so take the write back.
  const now = await first<{ photo: string | null }>(env.DB, "SELECT photo FROM users WHERE id = ?", u.id)
  if (now?.photo !== u.photo) await env.FILES.delete(`${prefix}${variant}`)
  return serve(bytes, type, IMMUTABLE)
}
