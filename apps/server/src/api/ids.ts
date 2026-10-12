// Identifiers shaped like Slack's: a one-letter kind, then upper-case base-36.

const ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ"

export function randomId(prefix: string, length = 10): string {
  const bytes = crypto.getRandomValues(new Uint8Array(length))
  let id = prefix
  for (const b of bytes) id += ALPHABET[b % ALPHABET.length]
  return id
}

export function randomSecret(bytes = 24): string {
  return [...crypto.getRandomValues(new Uint8Array(bytes))].map((b) => b.toString(16).padStart(2, "0")).join("")
}

export const ids = {
  team: () => randomId("T"),
  user: () => randomId("U"),
  bot: () => randomId("B"),
  app: () => randomId("A"),
  channel: () => randomId("C"),
  im: () => randomId("D"),
  mpim: () => randomId("G"),
  file: () => randomId("F"),
  event: () => randomId("Ev"),
  envelope: () => crypto.randomUUID(),
}

let lastMicros = 0

/**
 * A message timestamp, "seconds.micros": unique and increasing within this
 * isolate. Across isolates the (channel, ts) key catches a clash and the
 * writer asks again with `after`.
 */
export function nextTs(after?: string): string {
  let micros = Date.now() * 1000
  if (after) micros = Math.max(micros, tsToMicros(after) + 1 + Math.floor(Math.random() * 100))
  micros = Math.max(micros, lastMicros + 1)
  lastMicros = micros
  return microsToTs(micros)
}

export function tsToMicros(ts: string): number {
  const [s = "0", us = "0"] = ts.split(".")
  return Number(s) * 1_000_000 + Number(us.padEnd(6, "0").slice(0, 6))
}

export function microsToTs(micros: number): string {
  const s = Math.floor(micros / 1_000_000)
  return `${String(s).padStart(10, "0")}.${String(micros % 1_000_000).padStart(6, "0")}`
}

/** Normalises a client-supplied ts ("1727500000.0001", "1727500000") to the stored fixed width. */
export function normalizeTs(ts: string): string | undefined {
  if (!/^\d{1,10}(\.\d{1,6})?$/.test(ts)) return undefined
  return microsToTs(tsToMicros(ts))
}

export const nowSeconds = () => Math.floor(Date.now() / 1000)
