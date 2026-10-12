import { describe, expect, it } from "vitest"
import { decodePacket, durationMs, encodePacket, rms, Segmenter, toMono16k, wav } from "../src/huddle/audio"

/** 48 kHz stereo s16le: `ms` of a tone at `amplitude` (0 = silence), the same in both channels. */
function stereo48k(ms: number, amplitude: number, hz = 220): Uint8Array {
  const frames = (48_000 * ms) / 1000
  const out = new Uint8Array(frames * 4)
  const v = new DataView(out.buffer)
  for (let i = 0; i < frames; i++) {
    const s = Math.round(amplitude * Math.sin((2 * Math.PI * hz * i) / 48_000))
    v.setInt16(i * 4, s, true)
    v.setInt16(i * 4 + 2, s, true)
  }
  return out
}

const mono = (ms: number, amplitude: number) => toMono16k(stereo48k(ms, amplitude))

describe("adapter packets", () => {
  it("round-trips sequence number, timestamp and payload", () => {
    const payload = new Uint8Array([1, 2, 3, 250])
    const packet = { sequenceNumber: 300, timestamp: 4_000_000_000, payload }
    const decoded = decodePacket(encodePacket(packet))
    expect(decoded.sequenceNumber).toBe(300)
    expect(decoded.timestamp).toBe(4_000_000_000)
    expect([...decoded.payload]).toEqual([1, 2, 3, 250])
  })

  it("skips fields it doesn't know, of every wire type", () => {
    const known = encodePacket({ sequenceNumber: 7, timestamp: 9, payload: new Uint8Array([42]) })
    // field 3 varint, field 4 fixed64, field 6 fixed32, field 7 bytes — then the known fields.
    const extra = new Uint8Array([
      3 << 3,
      0x96,
      0x01,
      (4 << 3) | 1,
      1,
      2,
      3,
      4,
      5,
      6,
      7,
      8,
      (6 << 3) | 5,
      1,
      2,
      3,
      4,
      (7 << 3) | 2,
      2,
      9,
      9,
    ])
    const decoded = decodePacket(new Uint8Array([...extra, ...known]))
    expect(decoded).toMatchObject({ sequenceNumber: 7, timestamp: 9 })
    expect([...decoded.payload]).toEqual([42])
  })

  it("rejects malformed input", () => {
    expect(() => decodePacket(new Uint8Array([0x08, 0xff]))).toThrow("malformed varint")
    expect(() => decodePacket(new Uint8Array([(5 << 3) | 2, 10, 1]))).toThrow("truncated field")
    expect(() => decodePacket(new Uint8Array([(5 << 3) | 3]))).toThrow("unsupported wire type 3")
    expect(() => decodePacket(new Uint8Array(11).fill(0xff))).toThrow("malformed varint")
  })
})

describe("resampling", () => {
  it("averages channels and thirds the rate", () => {
    const pcm = new Uint8Array(4 * 6)
    const v = new DataView(pcm.buffer)
    // Six stereo frames: left 300, right 0 → mono 150, two output samples.
    for (let i = 0; i < 6; i++) v.setInt16(i * 4, 300, true)
    expect([...toMono16k(pcm)]).toEqual([150, 150])
    expect(toMono16k(stereo48k(1000, 1000)).length).toBe(16_000)
    // A ragged tail (half a frame) is ignored.
    expect(toMono16k(new Uint8Array(14)).length).toBe(1)
  })

  it("measures loudness", () => {
    expect(rms(new Int16Array(0))).toBe(0)
    expect(rms(new Int16Array([3, -4, 3, -4]))).toBeCloseTo(3.54, 1)
    expect(rms(mono(100, 8000))).toBeGreaterThan(5000)
  })
})

describe("Segmenter", () => {
  it("cuts utterances at silence, keeping a little audio from before", () => {
    const seg = new Segmenter()
    expect(seg.push(mono(500, 0))).toEqual([])
    expect(seg.push(mono(1000, 8000))).toEqual([])
    const [utterance, ...rest] = seg.push(mono(800, 0))
    expect(rest).toEqual([])
    // 200 ms of preroll + 1000 ms of speech + 700 ms of trailing silence.
    expect(durationMs(utterance!)).toBe(1900)
  })

  it("splits a monologue at the maximum length", () => {
    const seg = new Segmenter({ maxMs: 2000 })
    const done = seg.push(mono(5000, 8000))
    expect(done.map(durationMs)).toEqual([2000, 2000])
    expect(durationMs(seg.flush()!)).toBe(1000)
  })

  it("drops bursts too short to be speech, and quiet audio", () => {
    const seg = new Segmenter()
    expect(seg.push(mono(100, 8000))).toEqual([])
    expect(seg.push(mono(1000, 0))).toEqual([])
    expect(seg.push(mono(3000, 200))).toEqual([])
    expect(seg.flush()).toBeUndefined()
  })

  it("carries partial frames across pushes", () => {
    const seg = new Segmenter({ silenceMs: 100 })
    const speech = mono(1000, 8000)
    // Fed in uneven pieces, it cuts the same as fed whole.
    for (let i = 0; i < speech.length; i += 777) seg.push(speech.slice(i, i + 777))
    const [utterance] = seg.push(mono(200, 0))
    expect(durationMs(utterance!)).toBe(1100)
  })
})

describe("wav", () => {
  it("writes a 16 kHz mono PCM header and the samples", () => {
    const bytes = wav(new Int16Array([1, -1]))
    const v = new DataView(bytes.buffer)
    const text = (o: number, n: number) => String.fromCharCode(...bytes.subarray(o, o + n))
    expect([text(0, 4), text(8, 4), text(12, 4), text(36, 4)]).toEqual(["RIFF", "WAVE", "fmt ", "data"])
    expect([v.getUint16(22, true), v.getUint32(24, true), v.getUint16(34, true), v.getUint32(40, true)]).toEqual([
      1, 16000, 16, 4,
    ])
    expect([v.getInt16(44, true), v.getInt16(46, true)]).toEqual([1, -1])
    expect(bytes.length).toBe(48)
  })
})
