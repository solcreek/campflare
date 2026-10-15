// What we can tell about an upload from its name and first bytes.

const MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  pdf: "application/pdf",
  txt: "text/plain",
  log: "text/plain",
  md: "text/markdown",
  csv: "text/csv",
  json: "application/json",
  zip: "application/zip",
  gz: "application/gzip",
  mp4: "video/mp4",
  mov: "video/quicktime",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  html: "text/html",
}

export function mimeOf(filename: string): string {
  const ext = filename.split(".").pop()?.toLowerCase() ?? ""
  return MIME[ext] ?? "application/octet-stream"
}

/** Width and height of a PNG, GIF, JPEG or WebP, from its header. */
export function imageSize(b: Uint8Array): { width: number; height: number } | undefined {
  const at = (i: number) => b[i] ?? 0
  const be16 = (i: number) => (at(i) << 8) | at(i + 1)
  const le16 = (i: number) => at(i) | (at(i + 1) << 8)
  const be32 = (i: number) => ((at(i) << 24) | (at(i + 1) << 16) | (at(i + 2) << 8) | at(i + 3)) >>> 0
  const ascii = (i: number, n: number) => String.fromCharCode(...b.subarray(i, i + n))

  if (b.length >= 24 && at(0) === 0x89 && ascii(1, 3) === "PNG") return { width: be32(16), height: be32(20) }
  if (b.length >= 10 && ascii(0, 3) === "GIF") return { width: le16(6), height: le16(8) }
  if (b.length >= 30 && ascii(0, 4) === "RIFF" && ascii(8, 4) === "WEBP") {
    const chunk = ascii(12, 4)
    if (chunk === "VP8 ") return { width: le16(26) & 0x3fff, height: le16(28) & 0x3fff }
    if (chunk === "VP8L") {
      const bits = at(21) | (at(22) << 8) | (at(23) << 16) | (at(24) << 24)
      return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 }
    }
    if (chunk === "VP8X") {
      return {
        width: 1 + (at(24) | (at(25) << 8) | (at(26) << 16)),
        height: 1 + (at(27) | (at(28) << 8) | (at(29) << 16)),
      }
    }
  }
  if (b.length >= 4 && at(0) === 0xff && at(1) === 0xd8) {
    let i = 2
    while (i + 9 < b.length) {
      if (at(i) !== 0xff) return undefined
      const marker = at(i + 1)
      // SOF0–SOF15, except DHT (C4), JPG (C8) and DAC (CC), carry the frame size.
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { width: be16(i + 7), height: be16(i + 5) }
      }
      i += 2 + be16(i + 2)
    }
  }
  return undefined
}

/** The size of the colour table a GIF's packed flags byte announces. */
const colorTable = (flags: number) => (flags & 0x80 ? 3 * 2 ** ((flags & 0x07) + 1) : 0)

/**
 * Whether an image moves: a GIF with more than one frame (image descriptor), or a WebP whose
 * VP8X header sets the animation flag. A GIF's NETSCAPE loop extension alone doesn't count,
 * since encoders add it to single frames too. Walks the GIF's blocks, so it needs the whole file.
 */
export function isAnimated(b: Uint8Array): boolean {
  const ascii = (i: number, n: number) => String.fromCharCode(...b.subarray(i, i + n))
  if (b.length >= 21 && ascii(0, 4) === "RIFF" && ascii(8, 4) === "WEBP") {
    return ascii(12, 4) === "VP8X" && ((b[20] ?? 0) & 0x02) !== 0
  }
  if (b.length < 13 || ascii(0, 3) !== "GIF") return false
  /** The index after a run of data sub-blocks (length-prefixed, ended by a zero length). */
  const skipSubBlocks = (i: number) => {
    while (i < b.length && b[i] !== 0) i += b[i]! + 1
    return i + 1
  }
  let i = 13 + colorTable(b[10]!)
  let frames = 0
  while (i < b.length) {
    const block = b[i]
    if (block === 0x21) {
      i = skipSubBlocks(i + 2) // introducer, label
    } else if (block === 0x2c) {
      if (++frames > 1) return true
      i = skipSubBlocks(i + 10 + colorTable(b[i + 9] ?? 0) + 1) // descriptor, local table, LZW code size
    } else {
      return false // the trailer (0x3b), or not a GIF block
    }
  }
  return false
}

/**
 * A JPEG's EXIF orientation (1–8; 1 when there is none): how the stored pixels are turned to
 * stand upright. Browsers and the Images binding apply it, so 5–8 (a quarter turn) swap the
 * width and height people see.
 */
export function jpegOrientation(b: Uint8Array): number {
  const at = (i: number) => b[i] ?? 0
  const be16 = (i: number) => (at(i) << 8) | at(i + 1)
  if (at(0) !== 0xff || at(1) !== 0xd8) return 1
  let i = 2
  while (i + 4 < b.length && at(i) === 0xff) {
    const marker = at(i + 1)
    // Start of scan: no metadata after it.
    if (marker === 0xda) return 1
    if (marker === 0xe1 && String.fromCharCode(...b.subarray(i + 4, i + 10)) === "Exif\0\0") {
      const tiff = i + 10
      const little = at(tiff) === 0x49 // "II"; else "MM"
      const u16 = (j: number) => (little ? at(j) | (at(j + 1) << 8) : be16(j))
      const u32 = (j: number) => (little ? u16(j) + u16(j + 2) * 0x10000 : u16(j) * 0x10000 + u16(j + 2))
      const ifd = tiff + u32(tiff + 4)
      for (let e = 0; e < u16(ifd); e++) {
        const entry = ifd + 2 + e * 12
        if (u16(entry) === 0x0112) {
          const value = u16(entry + 8)
          return value >= 1 && value <= 8 ? value : 1
        }
      }
      return 1
    }
    i += 2 + be16(i + 2)
  }
  return 1
}

/** The size people see: the stored size, turned by a JPEG's EXIF orientation. */
export function displaySize(b: Uint8Array, size: { width: number; height: number }) {
  return jpegOrientation(b) >= 5 ? { width: size.height, height: size.width } : size
}
