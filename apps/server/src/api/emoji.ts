import type { Env } from "../env"
import { createMetadataFetch } from "../auth/cimd-fetch"
import { CampflareError } from "./errors"
import { imageSize, isAnimated } from "./media"
import { PHOTO_TYPES, photoType } from "./photos"
import { STANDARD_EMOJI_CATEGORIES, STANDARD_EMOJI_OTHER } from "./standard-emoji"
import { imagesOf } from "./thumbs"

// Custom emoji (docs in CLAUDE.md, **Custom emoji**): a workspace's own :name:,
// an image or an alias of another name. Images live in R2 at
// <team>/emoji/<image>, where <image> is random: a URL names one image for good
// (served immutable, no token, as profile photos), and a rename keeps it.

/** Slack's limit on an emoji image. */
export const EMOJI_MAX_BYTES = 128 * 1024
/** The box an emoji is shown in: bigger images are scaled down to fit when the Images binding is there. */
export const EMOJI_SIDE = 128
/** Bigger than this is refused outright: 128 KB can still decode to an enormous bitmap. */
const EMOJI_MAX_SIDE = 4096

const NAME = /^[a-z0-9_-]{1,100}$/

/**
 * Names that are Object.prototype's members (`constructor`, `__proto__`…): clients keep emoji
 * in plain objects keyed by name, where these would read as what they inherit.
 */
const PROTOTYPE_NAMES: ReadonlySet<string> = new Set(
  Object.getOwnPropertyNames(Object.prototype).map((n) => n.toLowerCase()),
)

/** Every standard short name, which custom emoji may not take. */
export const STANDARD_EMOJI: ReadonlySet<string> = new Set([
  ...STANDARD_EMOJI_CATEGORIES.flatMap(([, names]) => names.split(" ")),
  ...STANDARD_EMOJI_OTHER.split(" "),
])

/** A name as people type it (":Party-Parrot:") as stored, or undefined when there's none. */
export const nameOf = (raw: string | undefined) => raw?.trim().replace(/^:|:$/g, "").toLowerCase() || undefined

/**
 * A new emoji's name, checked as Slack checks it: lowercase letters, digits, - and _, up to
 * 100 characters, not a standard emoji's, and not one of Object.prototype's members.
 */
export function newName(raw: string | undefined): string {
  const name = nameOf(raw)
  if (!name) throw new CampflareError("error_missing_name")
  if (STANDARD_EMOJI.has(name)) throw new CampflareError("error_name_taken_i18n")
  if (!NAME.test(name) || PROTOTYPE_NAMES.has(name)) throw new CampflareError("error_bad_name_i18n")
  return name
}

export const emojiKey = (teamId: string, image: string) => `${teamId}/emoji/${image}`

export interface EmojiImage {
  bytes: Uint8Array<ArrayBuffer>
  type: string
}

/**
 * An uploaded image, checked (PNG, GIF, JPEG or WebP by its bytes, 128 KB at most) and scaled
 * down to fit 128 px when it's bigger and the Images binding is there. If Images fails, or
 * the result isn't smaller, the original is kept: it's within the byte limit either way.
 */
export async function emojiImage(env: Pick<Env, "IMAGES">, raw: Uint8Array<ArrayBuffer>): Promise<EmojiImage> {
  if (raw.byteLength === 0) throw new CampflareError("error_no_image")
  if (raw.byteLength > EMOJI_MAX_BYTES) throw new CampflareError("error_too_big")
  const type = photoType(raw)
  const size = imageSize(raw)
  if (!type || !size?.width || !size.height) throw new CampflareError("error_bad_format")
  if (Math.max(size.width, size.height) > EMOJI_MAX_SIDE) throw new CampflareError("error_too_big")
  const images = imagesOf(env)
  if (!images || Math.max(size.width, size.height) <= EMOJI_SIDE) return { bytes: raw, type }
  // A moving GIF stays a GIF; JPEG stays JPEG; the rest become PNG, which every client draws.
  const animated = type === "image/gif" && isAnimated(raw)
  const out = animated ? "image/gif" : type === "image/jpeg" ? "image/jpeg" : "image/png"
  try {
    const result = await images
      .input(new Blob([raw]).stream())
      .transform({ width: EMOJI_SIDE, height: EMOJI_SIDE, fit: "scale-down" })
      .output({ format: out, anim: animated })
    const bytes = new Uint8Array(await result.response().arrayBuffer())
    const scaled = imageSize(bytes)
    if (scaled && Math.max(scaled.width, scaled.height) <= EMOJI_SIDE && photoType(bytes) === out) {
      return { bytes, type: out }
    }
  } catch (error) {
    console.error("emoji resize failed", error)
  }
  return { bytes: raw, type }
}

/** An image emoji's URL: public, no token, as Slack's are. */
export const emojiUrl = (origin: string, teamId: string, image: string, type: string) =>
  `${origin}/emoji/${teamId}/${image}.${PHOTO_TYPES[type] ?? "img"}`

/** What emoji.list says a name is: its URL, or alias:<name>. */
export function emojiValue(
  origin: string,
  e: { team_id: string; image: string | null; image_type: string | null; alias_for: string | null },
) {
  return e.alias_for !== null ? `alias:${e.alias_for}` : emojiUrl(origin, e.team_id, e.image!, e.image_type!)
}

/** Slack's include_categories: the standard emoji by category. */
export const EMOJI_CATEGORIES = STANDARD_EMOJI_CATEGORIES.map(([name, names]) => ({
  name,
  emoji_names: names.split(" "),
}))

const IMMUTABLE = "public, max-age=31536000, immutable"

/** GET /emoji/<team>/<image>.<ext>: an emoji's image, straight from R2 (no query). Gone once removed. */
export async function handleEmoji(env: Pick<Env, "FILES">, teamId: string, file: string): Promise<Response> {
  const notFound = new Response("not found", { status: 404 })
  const [, image] = /^([0-9a-f]{8,64})\.[a-z]+$/.exec(file) ?? []
  if (!image || !/^T[A-Z0-9]+$/.test(teamId)) return notFound
  const object = await env.FILES.get(emojiKey(teamId, image))
  if (!object) return notFound
  return new Response(object.body, {
    headers: {
      "content-type": object.httpMetadata?.contentType ?? "application/octet-stream",
      "cache-control": IMMUTABLE,
      etag: object.httpEtag,
      // Bytes someone uploaded: never run as this origin's content.
      "content-security-policy": "sandbox",
      "x-content-type-options": "nosniff",
    },
  })
}

let emojiFetch: typeof fetch | undefined

/** For tests, which share the Worker's isolate: fetch admin.emoji.add's URLs without the network. */
export function setEmojiFetch(fetcher: typeof fetch | undefined) {
  emojiFetch = fetcher
}

/**
 * admin.emoji.add's image, from its URL, through the same SSRF guard as Client ID Metadata
 * Documents (cimd-fetch.ts: https only, public addresses only, no redirects, a timeout), and
 * read no further than the byte limit.
 */
export async function fetchEmojiImage(url: string): Promise<Uint8Array<ArrayBuffer>> {
  let res: Response
  try {
    res = await (emojiFetch ?? guarded)(new URL(url))
  } catch {
    throw new CampflareError("error_bad_upload")
  }
  if (res.status !== 200 || !res.body) {
    await res.body?.cancel()
    throw new CampflareError("error_bad_upload")
  }
  const chunks: Uint8Array[] = []
  let total = 0
  const reader = res.body.getReader()
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > EMOJI_MAX_BYTES) {
      await reader.cancel()
      throw new CampflareError("error_too_big")
    }
    chunks.push(value)
  }
  const bytes = new Uint8Array(total)
  let at = 0
  for (const c of chunks) {
    bytes.set(c, at)
    at += c.byteLength
  }
  return bytes
}

const guarded = createMetadataFetch()
