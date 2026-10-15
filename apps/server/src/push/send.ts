import type { Env } from "../env"
import { decode, utf8 } from "./base64url"
import { encrypt } from "./encrypt"
import { parseKeyPair } from "./keys"
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

/** The server's VAPID keys and contact, or undefined when push isn't configured. */
export function vapidOf(env: Pick<Env, "VAPID_PUBLIC_KEY" | "VAPID_PRIVATE_KEY" | "VAPID_SUBJECT">, origin: string) {
  const keys = parseKeyPair({ publicKey: env.VAPID_PUBLIC_KEY, privateKey: env.VAPID_PRIVATE_KEY })
  return keys ? { ...keys, subject: env.VAPID_SUBJECT || origin } : undefined
}

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

export interface PushOutcome {
  ok: boolean
  /** 0 when there was no answer. */
  status: number
  /** 404 or 410: the subscription is no more and should be forgotten. */
  gone: boolean
  /** 429, 5xx or no answer: worth trying again. */
  transient: boolean
  /** The service's Retry-After, in milliseconds, if it sent one. */
  retryAfterMs?: number
}

/** JWTs by audience and key, good for an hour here (12 for the service): a busy hub signs a few an hour. */
const jwts = new Map<string, { jwt: string; until: number }>()
const JWT_REUSE_MS = 60 * 60 * 1000

async function authorization(vapid: Vapid, audience: string): Promise<string> {
  const key = `${audience} ${vapid.subject} ${vapid.publicKey.join(",")}`
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
  const p256dh = decode(target.p256dh)
  const auth = decode(target.auth)
  if (!p256dh || !auth) return { ok: false, status: 0, gone: true, transient: false }
  try {
    const body = await encrypt(utf8(JSON.stringify(message.payload)), { p256dh, auth })
    const headers: Record<string, string> = {
      authorization: await authorization(vapid, new URL(target.endpoint).origin),
      "content-encoding": "aes128gcm",
      "content-type": "application/octet-stream",
      ttl: String(message.ttl ?? PUSH_TTL_S),
      urgency: message.urgency,
    }
    if (message.topic) headers.topic = message.topic
    const res = await (pushFetch ?? fetch)(target.endpoint, {
      method: "POST",
      headers,
      body,
      signal: AbortSignal.timeout(PUSH_TIMEOUT_MS),
    })
    // The body isn't needed; read it so the connection is released.
    await res.body?.cancel()
    const transient = res.status === 429 || res.status >= 500
    return {
      ok: res.ok,
      status: res.status,
      gone: res.status === 404 || res.status === 410,
      transient,
      ...(transient ? { retryAfterMs: retryAfter(res.headers.get("retry-after")) } : {}),
    }
  } catch (error) {
    // A key the browser gave that WebCrypto refuses is as good as gone; anything else is the network.
    if (error instanceof DOMException && error.name !== "TimeoutError" && error.name !== "AbortError") {
      return { ok: false, status: 0, gone: true, transient: false }
    }
    return { ok: false, status: 0, gone: false, transient: true }
  }
}
