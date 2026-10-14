// GIFs of any size and frame count for the thumbnail tests, server and live, made in code
// rather than kept as fixture files. No Worker types here: tests/live imports it in Node.

/**
 * A two-colour GIF of width×height (vertical stripes), with `frames` frames.
 * Local Images can't write GIF, so this encodes it: LZW with a clear code
 * after every two pixels keeps the codes 3 bits wide, never compressing.
 * `loop` adds the NETSCAPE2.0 extension (by default when animated), `comment`
 * a comment extension, `localTable` gives each frame its own colour table.
 */
export function makeGif(
  width: number,
  height: number,
  frames = 1,
  { loop = frames > 1, comment = false, localTable = false } = {},
): Uint8Array<ArrayBuffer> {
  const out: number[] = []
  const le16 = (n: number) => out.push(n & 0xff, n >> 8)
  out.push(...new TextEncoder().encode("GIF89a"))
  le16(width)
  le16(height)
  out.push(0x80, 0, 0) // a global table of 2 colours
  out.push(0xe7, 0x39, 0x2d, 0x3c, 0x98, 0x9f)
  if (comment) out.push(0x21, 0xfe, 5, ...new TextEncoder().encode("hola!"), 0)
  if (loop) {
    // NETSCAPE2.0: loop forever.
    out.push(0x21, 0xff, 11, ...new TextEncoder().encode("NETSCAPE2.0"), 3, 1, 0, 0, 0)
  }
  for (let frame = 0; frame < frames; frame++) {
    out.push(0x21, 0xf9, 4, 0, 10, 0, 0, 0) // 0.1 s per frame
    out.push(0x2c)
    le16(0)
    le16(0)
    le16(width)
    le16(height)
    if (localTable) out.push(0x80, 0x3c, 0x98, 0x9f, 0xe7, 0x39, 0x2d)
    else out.push(0)
    const codes: number[] = []
    for (let i = 0; i < width * height; i++) {
      if (i % 2 === 0) codes.push(4) // clear
      codes.push((Math.floor((i % width) / 8) + frame) % 2)
    }
    codes.push(5) // end of information
    const data: number[] = []
    let bits = 0
    let used = 0
    for (const code of codes) {
      bits |= code << used
      used += 3
      while (used >= 8) {
        data.push(bits & 0xff)
        bits >>= 8
        used -= 8
      }
    }
    if (used > 0) data.push(bits & 0xff)
    out.push(2) // minimum code size
    for (let i = 0; i < data.length; i += 255) {
      const block = data.slice(i, i + 255)
      out.push(block.length, ...block)
    }
    out.push(0)
  }
  out.push(0x3b)
  return new Uint8Array(out)
}
