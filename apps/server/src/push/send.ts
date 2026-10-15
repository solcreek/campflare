import { decode, encode, utf8 } from "./base64url"
import { encrypt, MAX_PLAINTEXT } from "./encrypt"
import { vapidAuthorization, vapidJwt, type Vapid } from "./vapid"

// One push (RFC 8030): an encrypted payload POSTed to a subscription's
// endpoint at its push service, signed with VAPID.

let pushFetch: typeof fetch | undefined

/** For tests, which run in the Worker's isolate (the hub's too): answer push services without the network. */
export function setPushFetch(fetcher: typeof fetch | undefined) {
  pushFetch = fetcher
}

/** A push service that hasn't answered by then is treated as down, and retried. */
export const PUSH_TIMEOUT_MS = 10_000

/** A day: a notification that waited longer is old news; the inbox still has it. */
export const PUSH_TTL_S = 24 * 60 * 60

export interface Target {
  endpoint: string
  p256dh: string
  auth: string
}

export interface PushMessage {
  payload: unknown
  urgency: "very-low" | "low" | "normal" | "high"
  /** Replaces a push to the same subscription still waiting at the service (RFC 8030 §5.4). */
  topic?: string
  ttl?: number
}

/**
 * How a push went. Exactly one of: `ok`; `gone` (404, 410, or keys of the
 * subscriber's that can't be used: forget the subscription); `transient` (429,
 * 5xx, no answer: try again); `misconfigured` (the server's own VAPID key
 * failed: neither the subscription's fault nor worth a retry); or none of
 * them, a refusal for good (400, 413, a payload that can't fit).
 */
export interface PushOutcome {
  ok: boolean
  /** 0 when there was no answer. */
  status: number
  gone: boolean
  transient: boolean
  misconfigured?: boolean
  /** The service's Retry-After, in milliseconds, if it sent one. */
  retryAfterMs?: number
}

const outcome = (o: Partial<PushOutcome>): PushOutcome => ({
  ok: false,
  status: 0,
  gone: false,
  transient: false,
  ...o,
})

/**
 * The payload as bytes that fit one push: if it's too long, its `body` (the
 * message text) is cut until it fits. Undefined if even that won't do.
 */
export function fitPayload(payload: unknown): Uint8Array<ArrayBuffer> | undefined {
  let bytes = utf8(JSON.stringify(payload))
  if (bytes.length <= MAX_PLAINTEXT) return bytes
  const record = payload as { body?: unknown } | null
  if (typeof record?.body !== "string") return undefined
  let chars = [...record.body]
  while (bytes.length > MAX_PLAINTEXT && chars.length > 0) {
    chars = chars.slice(0, Math.floor(chars.length * 0.8))
    bytes = utf8(JSON.stringify({ ...record, body: `${chars.join("")}…` }))
  }
  return bytes.length <= MAX_PLAINTEXT ? bytes : undefined
}

/** JWTs by audience, contact and key, good for an hour here (12 for the service): a busy hub signs a few an hour. */
const jwts = new Map<string, { jwt: string; until: number }>()
const JWT_REUSE_MS = 60 * 60 * 1000

async function authorization(vapid: Vapid, audience: string): Promise<string> {
  const key = `${audience} ${vapid.subject} ${encode(vapid.publicKey)}`
  const now = Date.now()
  let cached = jwts.get(key)
  if (!cached || cached.until <= now) {
    cached = { jwt: await vapidJwt(vapid, audience), until: now + JWT_REUSE_MS }
    jwts.set(key, cached)
  }
  return vapidAuthorization(cached.jwt, vapid.publicKey)
}

/** Retry-After as seconds or an HTTP date, in milliseconds from now. */
function retryAfter(value: string | null): number | undefined {
  if (!value) return undefined
  const seconds = Number(value)
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000)
  const at = Date.parse(value)
  return Number.isNaN(at) ? undefined : Math.max(0, at - Date.now())
}

/** Encrypts the payload for the subscription and POSTs it. Never throws: a failure is an outcome. */
export async function sendPush(vapid: Vapid, target: Target, message: PushMessage): Promise<PushOutcome> {
  const plaintext = fitPayload(message.payload)
  if (!plaintext) return outcome({})
  const p256dh = decode(target.p256dh)
  const auth = decode(target.auth)
  if (!p256dh || auth?.length !== 16) return outcome({ gone: true })
  let body: Uint8Array<ArrayBuffer>
  try {
    body = await encrypt(plaintext, { p256dh, auth })
  } catch {
    // The plaintext fits, so what failed is the subscriber's key: importing it, or ECDH with it.
    return outcome({ gone: true })
  }
  let signed: string
  try {
    signed = await authorization(vapid, new URL(target.endpoint).origin)
  } catch (error) {
    console.error("signing with the VAPID key failed", error)
    return outcome({ misconfigured: true })
  }
  const headers: Record<string, string> = {
    authorization: signed,
    "content-encoding": "aes128gcm",
    "content-type": "application/octet-stream",
    ttl: String(message.ttl ?? PUSH_TTL_S),
    urgency: message.urgency,
  }
  if (message.topic) headers.topic = message.topic
  let res: Response
  try {
    res = await (pushFetch ?? fetch)(target.endpoint, {
      method: "POST",
      headers,
      body,
      signal: AbortSignal.timeout(PUSH_TIMEOUT_MS),
    })
  } catch {
    // No answer: the network, or the timeout.
    return outcome({ transient: true })
  }
  // The body isn't needed; cancel it so the connection is released.
  await res.body?.cancel()
  const transient = res.status === 429 || res.status >= 500
  return outcome({
    ok: res.ok,
    status: res.status,
    gone: res.status === 404 || res.status === 410,
    transient,
    ...(transient ? { retryAfterMs: retryAfter(res.headers.get("retry-after")) } : {}),
  })
}
