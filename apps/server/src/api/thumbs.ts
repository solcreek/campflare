import type { FileRow } from "../db/rows"
import type { Env } from "../env"

// Image thumbnails (Slack's thumb_*), made by the Cloudflare Images binding on
// first fetch and kept in R2 beside the original. Which sizes a file has and
// their dimensions follow from original_w/original_h alone, so serialising a
// file costs no query.
//
// Slack's sizes: thumb_64 is a 64×64 square (cropped), thumb_80 an 80×80 one
// (the image fitted inside, padded with transparent pixels), thumb_160 fits in
// 160×160. thumb_360 fits in 360×360 and is always there (no bigger than the
// original), with thumb_360_w/_h; thumb_480 … thumb_1024 exist only when the
// original is bigger than that size, also with _w/_h.

const SQUARE = [64, 80, 160] as const
const FITTED = [360, 480, 720, 800, 960, 1024] as const
export const THUMB_SIZES: readonly number[] = [...SQUARE, ...FITTED]

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

/** The thumbnail sizes a file has: none unless it's an image of known size. */
export function thumbSizes(f: Sized): number[] {
  if (!THUMBABLE.has(f.mimetype) || !f.width || !f.height) return []
  const longest = Math.max(f.width, f.height)
  return [...SQUARE, 360, ...FITTED.filter((n) => n > 360 && longest > n)]
}

/** The size of a fitted thumbnail: the original scaled down (never up) to fit in size×size. */
export function fittedSize(size: number, width: number, height: number) {
  const scale = Math.min(1, size / Math.max(width, height))
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) }
}

/** JPEG stays JPEG; everything else becomes PNG, which keeps transparency (a GIF's first frame, for now). */
function format(f: Pick<FileRow, "mimetype">) {
  return f.mimetype === "image/jpeg"
    ? { type: "image/jpeg" as const, ext: "jpg" }
    : { type: "image/png" as const, ext: "png" }
}

/** The transformation that makes one size. */
export function thumbTransform(f: Pick<FileRow, "mimetype">, size: number): ImageTransform {
  if (size === 64) return { width: 64, height: 64, fit: "cover" }
  if (size === 80) {
    return { width: 80, height: 80, fit: "pad", background: f.mimetype === "image/jpeg" ? "#ffffff" : "#00000000" }
  }
  return { width: size, height: size, fit: "scale-down" }
}

export const thumbKey = (f: Pick<FileRow, "team_id" | "id">, size: number) => `${f.team_id}/${f.id}/thumb_${size}`

/** thumb_<size>.<ext> at the end of a thumbnail URL's name. */
export function thumbSizeOf(name: string): number | undefined {
  const size = Number(/_(\d+)\.(?:png|jpg)$/.exec(name)?.[1])
  return THUMB_SIZES.includes(size) ? size : undefined
}

/** The thumb_* fields of a file's JSON: none for a file without thumbnails, or when they're off. */
export function thumbsJson(origin: string, f: FileRow, enabled: boolean): Record<string, string | number> {
  const sizes = enabled ? thumbSizes(f) : []
  if (sizes.length === 0) return {}
  const { ext } = format(f)
  const stem = f.name.replace(/\.[^.]*$/, "") || "image"
  const base = `${origin}/files-tmb/${f.team_id}-${f.id}/`
  const json: Record<string, string | number> = {}
  for (const size of sizes) {
    json[`thumb_${size}`] = `${base}${encodeURIComponent(`${stem}_${size}.${ext}`)}`
    if (size >= 360) {
      const fitted = fittedSize(size, f.width!, f.height!)
      json[`thumb_${size}_w`] = fitted.width
      json[`thumb_${size}_h`] = fitted.height
    }
  }
  return json
}

/** Makes one thumbnail from the original's bytes; the result's type is the thumbnail's. */
export async function makeThumb(
  images: ImagesBinding,
  f: Pick<FileRow, "mimetype">,
  size: number,
  original: ReadableStream,
) {
  const out = await images
    .input(original)
    .transform(thumbTransform(f, size))
    .output({ format: format(f).type })
  return { bytes: await out.response().arrayBuffer(), contentType: out.contentType() }
}
