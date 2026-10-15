import { crc32, deflateRawSync } from "node:zlib"

// A minimal zip writer for tests: deflated or stored entries, optionally with
// ZIP64 records (as zips over 4 GiB or 65535 entries have), UTF-8 names.

export function makeZip(
  files: Record<string, string | Uint8Array>,
  { zip64 = false, store = false, comment = "" } = {},
): Uint8Array {
  const parts: Buffer[] = []
  const central: Buffer[] = []
  let offset = 0
  for (const [name, content] of Object.entries(files)) {
    const data = typeof content === "string" ? Buffer.from(content) : Buffer.from(content)
    const packed = store ? data : deflateRawSync(data)
    const nameBytes = Buffer.from(name)
    const crc = crc32(data)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(zip64 ? 45 : 20, 4)
    local.writeUInt16LE(0x0800, 6)
    local.writeUInt16LE(store ? 0 : 8, 8)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(packed.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(nameBytes.length, 26)
    parts.push(local, nameBytes, packed)

    const extra = zip64 ? Buffer.alloc(32) : Buffer.alloc(0)
    if (zip64) {
      // An unrelated extra field first, then ZIP64's: readers must skip what they don't know.
      extra.writeUInt16LE(0x5455, 0)
      extra.writeUInt16LE(0, 2)
      extra.writeUInt16LE(0x0001, 4)
      extra.writeUInt16LE(24, 6)
      extra.writeBigUInt64LE(BigInt(data.length), 8)
      extra.writeBigUInt64LE(BigInt(packed.length), 16)
      extra.writeBigUInt64LE(BigInt(offset), 24)
    }
    const entry = Buffer.alloc(46)
    entry.writeUInt32LE(0x02014b50, 0)
    entry.writeUInt16LE(zip64 ? 45 : 20, 4)
    entry.writeUInt16LE(zip64 ? 45 : 20, 6)
    entry.writeUInt16LE(0x0800, 8)
    entry.writeUInt16LE(store ? 0 : 8, 10)
    entry.writeUInt32LE(crc, 16)
    entry.writeUInt32LE(zip64 ? 0xffffffff : packed.length, 20)
    entry.writeUInt32LE(zip64 ? 0xffffffff : data.length, 24)
    entry.writeUInt16LE(nameBytes.length, 28)
    entry.writeUInt16LE(extra.length, 30)
    entry.writeUInt32LE(zip64 ? 0xffffffff : offset, 42)
    central.push(entry, nameBytes, extra)
    offset += 30 + nameBytes.length + packed.length
  }
  const cd = Buffer.concat(central)
  const count = Object.keys(files).length
  const tail: Buffer[] = []
  if (zip64) {
    const record = Buffer.alloc(56)
    record.writeUInt32LE(0x06064b50, 0)
    record.writeBigUInt64LE(44n, 4)
    record.writeUInt16LE(45, 12)
    record.writeUInt16LE(45, 14)
    record.writeBigUInt64LE(BigInt(count), 24)
    record.writeBigUInt64LE(BigInt(count), 32)
    record.writeBigUInt64LE(BigInt(cd.length), 40)
    record.writeBigUInt64LE(BigInt(offset), 48)
    const locator = Buffer.alloc(20)
    locator.writeUInt32LE(0x07064b50, 0)
    locator.writeBigUInt64LE(BigInt(offset + cd.length), 8)
    locator.writeUInt32LE(1, 16)
    tail.push(record, locator)
  }
  const commentBytes = Buffer.from(comment)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(zip64 ? 0xffff : count, 8)
  end.writeUInt16LE(zip64 ? 0xffff : count, 10)
  end.writeUInt32LE(zip64 ? 0xffffffff : cd.length, 12)
  end.writeUInt32LE(zip64 ? 0xffffffff : offset, 16)
  end.writeUInt16LE(commentBytes.length, 20)
  return new Uint8Array(Buffer.concat([...parts, cd, ...tail, end, commentBytes]))
}
