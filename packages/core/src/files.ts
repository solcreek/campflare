import type { MessageFile } from "./types"

// Files in messages, for any UI: what to show a file as, and its bytes.
// url_private needs the token, which <img src> can't send, so apps fetch the
// bytes and show them through an object URL that this cache shares and revokes.

/** Image types every browser draws. SVG is left out: it's a document that can run script. */
const INLINE_IMAGES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp", "image/avif"])

export type FileKind = "image" | "file" | "deleted"

export function fileKind(f: MessageFile): FileKind {
  if (f.mode === "tombstone") return "deleted"
  return f.url_private && f.mimetype && INLINE_IMAGES.has(f.mimetype) ? "image" : "file"
}

/** Alt text for an image, or a file's label: alt_txt, then title, then name. */
export function fileLabel(f: MessageFile): string {
  return f.alt_txt || f.title || f.name || "file"
}

/** "512 B", "1.5 KB", "12 MB": binary units, as Slack shows them. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 1024) return `${Math.max(0, Math.round(bytes || 0))} B`
  const units = ["KB", "MB", "GB", "TB"]
  let value = bytes
  let unit = -1
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit++
  }
  return `${value < 10 ? value.toFixed(1).replace(/\.0$/, "") : Math.round(value)} ${units[unit]}`
}

/** An image's size scaled down (never up) to fit the box, or the box when its size is unknown. */
export function fitImage(f: MessageFile, maxWidth: number, maxHeight: number): { width: number; height: number } {
  const w = f.original_w
  const h = f.original_h
  if (!w || !h) return { width: maxWidth, height: maxHeight }
  const scale = Math.min(1, maxWidth / w, maxHeight / h)
  return { width: Math.max(1, Math.round(w * scale)), height: Math.max(1, Math.round(h * scale)) }
}

/** Slack's fitted thumbnails (thumb_<n> with thumb_<n>_w/_h), smallest first. */
const THUMBS = [360, 480, 720, 800, 960, 1024]
/** The ones an animated image also has as a moving GIF (thumb_<n>_gif, sized as thumb_<n>). */
const GIF_THUMBS = [360, 480]

/**
 * The URL to draw an image from in a box of width×height CSS pixels: the smallest thumbnail
 * (thumb_*) that covers it at `pixelRatio` device pixels per CSS pixel, else the original.
 * An animated image (one with thumb_360_gif) picks among its GIF thumbnails, since the others
 * are stills; a GIF without them is still.
 */
export function imageSource(f: MessageFile, width: number, height: number, pixelRatio = 1): string | undefined {
  const animated = typeof f.thumb_360_gif === "string"
  // A pixel short still looks sharp, and rounding on either side can cost one.
  const needW = Math.ceil(width * pixelRatio) - 1
  const needH = Math.ceil(height * pixelRatio) - 1
  for (const size of animated ? GIF_THUMBS : THUMBS) {
    const url = f[animated ? `thumb_${size}_gif` : `thumb_${size}`]
    const w = f[`thumb_${size}_w`]
    const h = f[`thumb_${size}_h`]
    if (typeof url !== "string" || typeof w !== "number" || typeof h !== "number") continue
    // Covers the box, or is already the original's full size.
    if ((w >= needW && h >= needH) || (w === f.original_w && h === f.original_h)) return url
  }
  return f.url_private
}

/** Names clipboards give pasted content: "image.png" in Chromium and Firefox, "Pasted Graphic.png" from macOS apps. */
const GENERIC_NAME = /^(image|blob|untitled|pasted graphic( \d+)?)?(\.[a-z0-9]+)?$/i

const EXTENSIONS: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/avif": "avif",
}

const pad = (n: number) => String(n).padStart(2, "0")

/**
 * A pasted file's name: its own when it has a real one, else "Pasted image 2026-10-12 at 14.03.05.png"
 * in local time. `index` numbers the second and later files of one paste: "… (2).png".
 */
export function pastedFileName(name: string, type: string, when: Date, index = 0): string {
  if (!GENERIC_NAME.test(name.trim())) return name
  const ext = EXTENSIONS[type] ?? /\.([a-z0-9]+)$/i.exec(name)?.[1]?.toLowerCase()
  const date = `${when.getFullYear()}-${pad(when.getMonth() + 1)}-${pad(when.getDate())}`
  const time = `${pad(when.getHours())}.${pad(when.getMinutes())}.${pad(when.getSeconds())}`
  const what = type.startsWith("image/") ? "image" : "file"
  const base = `Pasted ${what} ${date} at ${time}${index > 0 ? ` (${index + 1})` : ""}`
  return ext ? `${base}.${ext}` : base
}

export interface FileCacheOptions {
  /** A GET with the session's token: client.fetchFile. */
  fetchFile: (url: string) => Promise<Response>
  createObjectURL?: (blob: Blob) => string
  revokeObjectURL?: (url: string) => void
  /**
   * How long an object URL nobody holds is kept, so a remount (a scroll back, React's
   * StrictMode) reuses it rather than fetching again.
   */
  graceMs?: number
}

export interface FileCache {
  /** An object URL for the file's bytes, fetched once however many hold it. Pair with release(). */
  acquire(url: string): Promise<string>
  /** Lets go of an acquire(); the object URL is revoked once nobody holds it for graceMs. */
  release(url: string): void
  /** The bytes, uncached: for a one-off download. */
  blob(url: string): Promise<Blob>
  /** Revokes every object URL. */
  clear(): void
}

interface Entry {
  holders: number
  objectUrl: Promise<string>
  timer?: ReturnType<typeof setTimeout>
}

export function createFileCache(options: FileCacheOptions): FileCache {
  const create = options.createObjectURL ?? ((b: Blob) => URL.createObjectURL(b))
  const revoke = options.revokeObjectURL ?? ((u: string) => URL.revokeObjectURL(u))
  const graceMs = options.graceMs ?? 30_000
  const entries = new Map<string, Entry>()

  async function blob(url: string) {
    const res = await options.fetchFile(url)
    if (!res.ok) throw new Error(`fetching ${url} failed: HTTP ${res.status}`)
    return res.blob()
  }

  function drop(url: string, entry: Entry) {
    if (entries.get(url) === entry) entries.delete(url)
    clearTimeout(entry.timer)
    entry.objectUrl.then(revoke, () => {})
  }

  return {
    acquire(url) {
      let entry = entries.get(url)
      if (!entry) {
        const fresh: Entry = { holders: 0, objectUrl: blob(url).then(create) }
        // A failed fetch isn't cached: the next acquire tries again.
        fresh.objectUrl.catch(() => entries.get(url) === fresh && entries.delete(url))
        entries.set(url, fresh)
        entry = fresh
      }
      clearTimeout(entry.timer)
      entry.timer = undefined
      entry.holders++
      return entry.objectUrl
    },
    release(url) {
      const entry = entries.get(url)
      if (!entry || entry.holders === 0) return
      entry.holders--
      if (entry.holders > 0) return
      entry.timer = setTimeout(() => drop(url, entry), graceMs)
    },
    blob,
    clear() {
      for (const [url, entry] of entries) drop(url, entry)
    },
  }
}
