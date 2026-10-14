import type { FileRow } from "../db/rows"
import type { Env } from "../env"

// Image thumbnails (Slack's thumb_*), made by the Cloudflare Images binding on
// first fetch and kept in R2 beside the original. Which sizes a file has and
// their dimensions follow from original_w/original_h (and the animated flag)
// alone, so serialising a file costs no query.
//
// Slack's sizes: thumb_64 is a 64×64 square (cropped), thumb_80 an 80×80 one
// (the image fitted inside, padded with transparent pixels), thumb_160 fits in
// 160×160. thumb_360 fits in 360×360 and is always there (no bigger than the
// original), with thumb_360_w/_h; thumb_480 … thumb_1024 exist only when the
// original is bigger than that size, also with _w/_h.
//
// Animated images (files.animated) also get Slack's thumb_360_gif and, beside
// thumb_480, thumb_480_gif: the animation fitted in that box, as a GIF; and
// deanimate_gif, the first frame at full size as a PNG. The other sizes are
// stills, as on Slack.
//
// Output: JPEG stays JPEG, everything else becomes PNG (GIF for *_gif), formats
// every client draws. WebP or AVIF would be smaller, but a client fetches
// thumb_* without saying what it accepts, and older ones can't show them.

const SQUARE = [64, 80, 160] as const
const FITTED = [360, 480, 720, 800, 960, 1024] as const
export const THUMB_SIZES: readonly number[] = [...SQUARE, ...FITTED]
/** The fitted sizes an animated image also has as a GIF (thumb_<n>_gif). */
const GIF_SIZES: readonly number[] = [360, 480]
const DEANIMATE = "deanimate_gif"

/**
 * One thumbnail of a file: a size ("64" … "1024"), a size's animated GIF ("360_gif", "480_gif"),
 * or "deanimate_gif". It names the JSON field (thumb_<variant>, or deanimate_gif) and the R2 key.
 */
export type ThumbVariant = string

/** Every variant there is, for deleting a file's thumbnails. */
export const THUMB_VARIANTS: readonly ThumbVariant[] = [
  ...THUMB_SIZES.map(String),
  ...GIF_SIZES.map((n) => `${n}_gif`),
  DEANIMATE,
]

/** What browsers draw and Images reads. SVG is left out: it's a document, and may run script. */
const THUMBABLE = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"])

let override: ImagesBinding | null | undefined

/**
 * For tests, which run in the Worker's isolate: replace the Images binding
 * (a failing one, say), `null` to act as if it weren't configured, or
 * `undefined` to use the real one again.
 */
export function setImagesOverride(binding: ImagesBinding | null | undefined) {
  override = binding
}

/** The Images binding, or undefined when thumbnails are off. */
export function imagesOf(env: Pick<Env, "IMAGES">): ImagesBinding | undefined {
  return override === undefined ? env.IMAGES : (override ?? undefined)
}

type Sized = Pick<FileRow, "mimetype" | "width" | "height">

/** Whether a file moves: animated at upload, or a GIF uploaded before that was recorded (NULL). */
export function isMoving(f: Pick<FileRow, "mimetype" | "animated">): boolean {
  return f.animated === 1 || (f.animated === null && f.mimetype === "image/gif")
}

/** The thumbnail sizes a file has: none unless it's an image of known size. */
export function thumbSizes(f: Sized): number[] {
  if (!THUMBABLE.has(f.mimetype) || !f.width || !f.height) return []
  const longest = Math.max(f.width, f.height)
  return [...SQUARE, 360, ...FITTED.filter((n) => n > 360 && longest > n)]
}

/** The thumbnails a file has: its sizes, then for an animated image the GIFs and deanimate_gif. */
export function thumbVariants(f: Sized & Pick<FileRow, "animated">): ThumbVariant[] {
  const sizes = thumbSizes(f)
  const variants = sizes.map(String)
  if (sizes.length > 0 && isMoving(f)) {
    variants.push(...GIF_SIZES.filter((n) => sizes.includes(n)).map((n) => `${n}_gif`), DEANIMATE)
  }
  return variants
}

/** The size of a fitted thumbnail: the original scaled down (never up) to fit in size×size. */
export function fittedSize(size: number, width: number, height: number) {
  const scale = Math.min(1, size / Math.max(width, height))
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) }
}

/** JPEG stays JPEG; everything else becomes PNG, which keeps transparency (a GIF's first frame). */
function format(f: Pick<FileRow, "mimetype">) {
  return f.mimetype === "image/jpeg"
    ? { type: "image/jpeg" as const, ext: "jpg" }
    : { type: "image/png" as const, ext: "png" }
}

/** The box a variant fits in: 360 for "360" and "360_gif"; undefined for deanimate_gif (full size). */
export const variantSize = (variant: ThumbVariant) => (variant === DEANIMATE ? undefined : Number.parseInt(variant))

const isGif = (variant: ThumbVariant) => variant.endsWith("_gif") && variant !== DEANIMATE

/** The transformation that makes one size. */
export function thumbTransform(f: Pick<FileRow, "mimetype">, size: number): ImageTransform {
  if (size === 64) return { width: 64, height: 64, fit: "cover" }
  if (size === 80) {
    return { width: 80, height: 80, fit: "pad", background: f.mimetype === "image/jpeg" ? "#ffffff" : "#00000000" }
  }
  return { width: size, height: size, fit: "scale-down" }
}

/** The JSON field of a variant: thumb_360, thumb_360_gif, deanimate_gif. */
const fieldOf = (variant: ThumbVariant) => (variant === DEANIMATE ? DEANIMATE : `thumb_${variant}`)

export const thumbKey = (f: Pick<FileRow, "team_id" | "id">, variant: ThumbVariant) =>
  `${f.team_id}/${f.id}/${fieldOf(variant)}`

/**
 * The variant a thumbnail URL's name ends with: _<size>.png or .jpg, _<360|480>.gif for the
 * animated ones, _deanimate_gif.png.
 */
export function thumbVariantOf(name: string): ThumbVariant | undefined {
  if (name.endsWith(`_${DEANIMATE}.png`)) return DEANIMATE
  const [, digits, ext] = /_(\d+)\.(png|jpg|gif)$/.exec(name) ?? []
  const size = Number(digits)
  if (ext === "gif") return GIF_SIZES.includes(size) ? `${size}_gif` : undefined
  return THUMB_SIZES.includes(size) ? String(size) : undefined
}

/** The name in a thumbnail's URL: the file's name without its extension, then the variant's. */
function thumbName(stem: string, variant: ThumbVariant, ext: string) {
  if (variant === DEANIMATE) return `${stem}_${DEANIMATE}.png`
  return isGif(variant) ? `${stem}_${variantSize(variant)}.gif` : `${stem}_${variant}.${ext}`
}

/**
 * Whether a variant is the original as it is: an animated GIF's thumb_<n>_gif when the GIF
 * already fits in n×n (Slack sends thumb_360_gif for a GIF smaller than 360 too).
 */
export function isOriginal(f: Sized, variant: ThumbVariant): boolean {
  const size = variantSize(variant)
  return isGif(variant) && f.mimetype === "image/gif" && Math.max(f.width ?? 0, f.height ?? 0) <= size!
}

/** The thumb_* fields of a file's JSON: none for a file without thumbnails, or when they're off. */
export function thumbsJson(origin: string, f: FileRow, enabled: boolean): Record<string, string | number> {
  const variants = enabled ? thumbVariants(f) : []
  if (variants.length === 0) return {}
  const { ext } = format(f)
  const stem = f.name.replace(/\.[^.]*$/, "") || "image"
  const base = `${origin}/files-tmb/${f.team_id}-${f.id}/`
  const json: Record<string, string | number> = {}
  for (const variant of variants) {
    json[fieldOf(variant)] = `${base}${encodeURIComponent(thumbName(stem, variant, ext))}`
    const size = Number(variant)
    if (size >= 360) {
      const fitted = fittedSize(size, f.width!, f.height!)
      json[`thumb_${size}_w`] = fitted.width
      json[`thumb_${size}_h`] = fitted.height
    }
  }
  return json
}

/**
 * Makes one thumbnail from the original's bytes; the result's type is the thumbnail's. Only
 * thumb_<n>_gif keeps the frames (`anim`); Images caps those at 50 megapixels over all frames.
 */
export async function makeThumb(
  images: ImagesBinding,
  f: Pick<FileRow, "mimetype">,
  variant: ThumbVariant,
  original: ReadableStream,
) {
  const input = images.input(original)
  const size = variantSize(variant)
  const transformed = size === undefined ? input : input.transform(thumbTransform(f, size))
  const out = await transformed.output(
    isGif(variant)
      ? { format: "image/gif", anim: true }
      : { format: variant === DEANIMATE ? "image/png" : format(f).type, anim: false },
  )
  return { bytes: await out.response().arrayBuffer(), contentType: out.contentType() }
}
