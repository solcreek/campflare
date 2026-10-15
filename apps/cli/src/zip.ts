import { createHash } from "node:crypto"
import { inflateRaw } from "node:zlib"
import { promisify } from "node:util"

// A zip reader on Node's zlib, for exports (docs/import.md): it reads the
// central directory from the end of the file, then one entry at a time from
// its offset, so memory holds the directory and one entry, never the zip.

const inflate = promisify(inflateRaw)

/** A file read by offset: an open file, or bytes already in memory. */
export interface RandomAccess {
  size: number
  read(offset: number, length: number): Promise<Uint8Array>
  close(): Promise<void>
}

export interface ZipEntry {
  name: string
  /** 0 stored, 8 deflated. */
  method: number
  compressedSize: number
  size: number
  /** Where its local header starts. */
  offset: number
}

export interface Zip {
  entries: ZipEntry[]
  /** The SHA-256 of the central directory, hex: the same zip gives the same one, without reading it all. */
  fingerprint: string
  read(entry: ZipEntry): Promise<Uint8Array>
  close(): Promise<void>
}

export class ZipError extends Error {}

const EOCD = 0x06054b50
const ZIP64_LOCATOR = 0x07064b50
const ZIP64_EOCD = 0x06064b50
const CENTRAL = 0x02014b50
const LOCAL = 0x04034b50

export function memoryAccess(bytes: Uint8Array): RandomAccess {
  return {
    size: bytes.byteLength,
    read: async (offset, length) => bytes.subarray(offset, offset + length),
    close: async () => {},
  }
}

const view = (b: Uint8Array) => new DataView(b.buffer, b.byteOffset, b.byteLength)
const u64 = (v: DataView, at: number) => Number(v.getBigUint64(at, true))

export async function openZip(file: RandomAccess): Promise<Zip> {
  // The end record is 22 bytes plus a comment of at most 64 KiB.
  const tailLength = Math.min(file.size, 22 + 0xffff)
  const tail = await file.read(file.size - tailLength, tailLength)
  const t = view(tail)
  let at = -1
  for (let i = tail.byteLength - 22; i >= 0; i--) {
    if (t.getUint32(i, true) === EOCD) {
      at = i
      break
    }
  }
  if (at < 0) throw new ZipError("not a zip file (no end of central directory)")
  let count = t.getUint16(at + 10, true)
  let cdSize = t.getUint32(at + 12, true)
  let cdOffset = t.getUint32(at + 16, true)
  if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
    // ZIP64: the locator sits just before the end record and says where the real one is.
    const locatorAt = at - 20
    if (locatorAt < 0 || t.getUint32(locatorAt, true) !== ZIP64_LOCATOR) throw new ZipError("broken ZIP64 zip")
    const end = view(await file.read(u64(t, locatorAt + 8), 56))
    if (end.getUint32(0, true) !== ZIP64_EOCD) throw new ZipError("broken ZIP64 zip")
    count = u64(end, 32)
    cdSize = u64(end, 40)
    cdOffset = u64(end, 48)
  }
  const cd = await file.read(cdOffset, cdSize)
  const c = view(cd)
  const decoder = new TextDecoder()
  const entries: ZipEntry[] = []
  let p = 0
  for (let i = 0; i < count; i++) {
    if (p + 46 > cd.byteLength || c.getUint32(p, true) !== CENTRAL) throw new ZipError("broken central directory")
    const nameLength = c.getUint16(p + 28, true)
    const extraLength = c.getUint16(p + 30, true)
    const commentLength = c.getUint16(p + 32, true)
    let compressedSize = c.getUint32(p + 20, true)
    let size = c.getUint32(p + 24, true)
    let offset = c.getUint32(p + 42, true)
    // Names are UTF-8 (Slack's are, CJK channel names included), flagged or not.
    const name = decoder.decode(cd.subarray(p + 46, p + 46 + nameLength))
    // A ZIP64 extra field holds the sizes and offset too big for 32 bits, in this order.
    let e = p + 46 + nameLength
    const extraEnd = e + extraLength
    while (e + 4 <= extraEnd) {
      const id = c.getUint16(e, true)
      const length = c.getUint16(e + 2, true)
      if (id === 0x0001) {
        let q = e + 4
        if (size === 0xffffffff) {
          size = u64(c, q)
          q += 8
        }
        if (compressedSize === 0xffffffff) {
          compressedSize = u64(c, q)
          q += 8
        }
        if (offset === 0xffffffff) offset = u64(c, q)
      }
      e += 4 + length
    }
    entries.push({ name, method: c.getUint16(p + 10, true), compressedSize, size, offset })
    p = extraEnd + commentLength
  }
  return {
    entries,
    fingerprint: createHash("sha256").update(cd).digest("hex"),
    async read(entry) {
      const header = view(await file.read(entry.offset, 30))
      if (header.getUint32(0, true) !== LOCAL) throw new ZipError(`broken entry: ${entry.name}`)
      const start = entry.offset + 30 + header.getUint16(26, true) + header.getUint16(28, true)
      const data = await file.read(start, entry.compressedSize)
      if (entry.method === 0) return data
      if (entry.method === 8) return new Uint8Array(await inflate(data))
      throw new ZipError(`${entry.name}: compression method ${entry.method} isn't supported`)
    },
    close: () => file.close(),
  }
}
