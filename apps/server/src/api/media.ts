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
