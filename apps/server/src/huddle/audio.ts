// Audio from the SFU's WebSocket adapter, made ready for speech recognition:
// protobuf packets of 48 kHz stereo PCM in, utterances of 16 kHz mono WAV out.

export interface Packet {
  sequenceNumber: number
  timestamp: number
  payload: Uint8Array
}

/** Reads a varint at `offset`: [value, next offset]. Values here fit in 32 bits. */
function varint(bytes: Uint8Array, offset: number): [number, number] {
  let value = 0
  let shift = 0
  for (let i = offset; i < bytes.length; i++) {
    const b = bytes[i]!
    value += (b & 0x7f) * 2 ** shift
    if ((b & 0x80) === 0) return [value, i + 1]
    shift += 7
    if (shift > 63) break
  }
  throw new Error("malformed varint")
}

/**
 * The adapter's packet: `{ uint32 sequenceNumber = 1; uint32 timestamp = 2;
 * bytes payload = 5; }`. Unknown fields are skipped, as protobuf requires.
 */
export function decodePacket(bytes: Uint8Array): Packet {
  const packet: Packet = { sequenceNumber: 0, timestamp: 0, payload: new Uint8Array(0) }
  let i = 0
  while (i < bytes.length) {
    const [key, next] = varint(bytes, i)
    i = next
    const field = Math.floor(key / 8)
    const wire = key & 7
    if (wire === 0) {
      const [value, after] = varint(bytes, i)
      i = after
      if (field === 1) packet.sequenceNumber = value
      else if (field === 2) packet.timestamp = value
    } else if (wire === 2) {
      const [length, after] = varint(bytes, i)
      if (after + length > bytes.length) throw new Error("truncated field")
      if (field === 5) packet.payload = bytes.subarray(after, after + length)
      i = after + length
    } else if (wire === 5) {
      i += 4
    } else if (wire === 1) {
      i += 8
    } else {
      throw new Error(`unsupported wire type ${wire}`)
    }
  }
  return packet
}

function writeVarint(out: number[], value: number) {
  let v = value
  while (v >= 0x80) {
    out.push((v & 0x7f) | 0x80)
    v = Math.floor(v / 128)
  }
  out.push(v)
}

/** The same packet, encoded: for audio sent into the SFU, and for tests. */
export function encodePacket(p: Packet): Uint8Array {
  const head: number[] = []
  writeVarint(head, (1 << 3) | 0)
  writeVarint(head, p.sequenceNumber)
  writeVarint(head, (2 << 3) | 0)
  writeVarint(head, p.timestamp)
  writeVarint(head, (5 << 3) | 2)
  writeVarint(head, p.payload.length)
  const out = new Uint8Array(head.length + p.payload.length)
  out.set(head)
  out.set(p.payload, head.length)
  return out
}

/**
 * 48 kHz stereo s16le → 16 kHz mono: average the channels, then average each
 * run of three samples (a box filter, enough against aliasing for speech).
 */
export function toMono16k(pcm: Uint8Array): Int16Array {
  const view = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength - (pcm.byteLength % 4))
  const frames = view.byteLength / 4
  const out = new Int16Array(Math.floor(frames / 3))
  for (let o = 0; o < out.length; o++) {
    let sum = 0
    for (let k = 0; k < 3; k++) {
      const f = (o * 3 + k) * 4
      sum += view.getInt16(f, true) + view.getInt16(f + 2, true)
    }
    out[o] = Math.round(sum / 6)
  }
  return out
}

export function rms(samples: Int16Array): number {
  if (samples.length === 0) return 0
  let sum = 0
  for (const s of samples) sum += s * s
  return Math.sqrt(sum / samples.length)
}

export interface SegmenterOptions {
  /** RMS above which a 20 ms frame counts as speech (s16 units; ~500 is −36 dBFS). */
  threshold?: number
  /** Silence that ends an utterance. */
  silenceMs?: number
  /** Utterances are cut at this length, so a monologue still arrives in pieces. */
  maxMs?: number
  /** Shorter bursts (a cough, a click) are dropped. */
  minSpeechMs?: number
  /** Audio kept from before speech starts, so first syllables aren't clipped. */
  prerollMs?: number
}

const RATE = 16_000
const FRAME = 320 // 20 ms at 16 kHz

/** Cuts a stream of 16 kHz mono audio into utterances by loudness. */
export class Segmenter {
  private readonly threshold: number
  private readonly silenceFrames: number
  private readonly maxFrames: number
  private readonly minSpeechFrames: number
  private readonly prerollFrames: number
  private pending = new Int16Array(0)
  private preroll: Int16Array[] = []
  private current: Int16Array[] = []
  private speechFrames = 0
  private quietFrames = 0

  constructor(options: SegmenterOptions = {}) {
    this.threshold = options.threshold ?? 500
    this.silenceFrames = Math.round((options.silenceMs ?? 700) / 20)
    this.maxFrames = Math.round((options.maxMs ?? 15_000) / 20)
    this.minSpeechFrames = Math.round((options.minSpeechMs ?? 300) / 20)
    this.prerollFrames = Math.round((options.prerollMs ?? 200) / 20)
  }

  /** Feeds audio; returns the utterances it completed. */
  push(samples: Int16Array): Int16Array[] {
    const all = new Int16Array(this.pending.length + samples.length)
    all.set(this.pending)
    all.set(samples, this.pending.length)
    const done: Int16Array[] = []
    let i = 0
    for (; i + FRAME <= all.length; i += FRAME) {
      const frame = all.slice(i, i + FRAME)
      const loud = rms(frame) >= this.threshold
      if (this.current.length === 0) {
        if (!loud) {
          this.preroll.push(frame)
          if (this.preroll.length > this.prerollFrames) this.preroll.shift()
          continue
        }
        this.current = [...this.preroll]
        this.preroll = []
        this.speechFrames = 0
        this.quietFrames = 0
      }
      this.current.push(frame)
      if (loud) {
        this.speechFrames++
        this.quietFrames = 0
      } else {
        this.quietFrames++
      }
      if (this.quietFrames >= this.silenceFrames || this.current.length >= this.maxFrames) {
        const utterance = this.take()
        if (utterance) done.push(utterance)
      }
    }
    this.pending = all.slice(i)
    return done
  }

  /** Whatever utterance is in progress, as when the speaker leaves. */
  flush(): Int16Array | undefined {
    return this.take()
  }

  private take(): Int16Array | undefined {
    const frames = this.current
    const speech = this.speechFrames
    this.current = []
    this.speechFrames = 0
    this.quietFrames = 0
    if (frames.length === 0 || speech < this.minSpeechFrames) return undefined
    const out = new Int16Array(frames.length * FRAME)
    frames.forEach((f, k) => out.set(f, k * FRAME))
    return out
  }
}

/** A 16 kHz mono 16-bit WAV file. */
export function wav(samples: Int16Array): Uint8Array {
  const out = new Uint8Array(44 + samples.length * 2)
  const v = new DataView(out.buffer)
  const ascii = (offset: number, text: string) => [...text].forEach((c, k) => v.setUint8(offset + k, c.charCodeAt(0)))
  ascii(0, "RIFF")
  v.setUint32(4, 36 + samples.length * 2, true)
  ascii(8, "WAVE")
  ascii(12, "fmt ")
  v.setUint32(16, 16, true)
  v.setUint16(20, 1, true) // PCM
  v.setUint16(22, 1, true) // mono
  v.setUint32(24, RATE, true)
  v.setUint32(28, RATE * 2, true)
  v.setUint16(32, 2, true)
  v.setUint16(34, 16, true)
  ascii(36, "data")
  v.setUint32(40, samples.length * 2, true)
  samples.forEach((s, k) => v.setInt16(44 + k * 2, s, true))
  return out
}

export const durationMs = (samples: Int16Array) => (samples.length / RATE) * 1000
