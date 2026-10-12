const encoder = new TextEncoder()

export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(value))
  return toHex(new Uint8Array(digest))
}

function toHex(bytes: Uint8Array) {
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("")
}

async function hmac(key: string, value: string): Promise<string> {
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    encoder.encode(key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  )
  const sig = await crypto.subtle.sign("HMAC", cryptoKey, encoder.encode(value))
  return toHex(new Uint8Array(sig)).slice(0, 32)
}

/** `payload.signature`, for values handed out in URLs (upload URLs, WebSocket tickets). */
export async function sign(key: string, payload: string): Promise<string> {
  return `${payload}.${await hmac(key, payload)}`
}

/** The payload of a value made by sign(), or undefined if it was tampered with. */
export async function verify(key: string, signed: string): Promise<string | undefined> {
  const dot = signed.lastIndexOf(".")
  if (dot < 0) return undefined
  const payload = signed.slice(0, dot)
  const expected = await hmac(key, payload)
  const actual = signed.slice(dot + 1)
  if (expected.length !== actual.length) return undefined
  let diff = 0
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ actual.charCodeAt(i)
  return diff === 0 ? payload : undefined
}
