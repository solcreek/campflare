import { encode, utf8 } from "./base64url"
import { importPrivate, importPublic, parseKeyPair } from "./keys"

// VAPID (RFC 8292): the server identifies itself to a push service with a JWT
// signed by its key (ES256), sent with the public key on every push.

/** How long a JWT is good for: push services refuse more than 24 hours. */
export const JWT_LIFETIME_S = 12 * 60 * 60

export interface Vapid {
  /** The public key's uncompressed point. */
  publicKey: Uint8Array
  /** The private key, imported for ECDSA signing. */
  signingKey: CryptoKey
  /** A mailto: or https: contact for the push service's operators. */
  subject: string
}

/** A signed JWT for one push service: its origin is the audience. */
export async function vapidJwt(vapid: Vapid, audience: string, now = Math.floor(Date.now() / 1000)): Promise<string> {
  const header = encode(utf8(JSON.stringify({ typ: "JWT", alg: "ES256" })))
  const claims = encode(utf8(JSON.stringify({ aud: audience, exp: now + JWT_LIFETIME_S, sub: vapid.subject })))
  // WebCrypto's ECDSA signature is r || s, 64 bytes: what JWS wants for ES256.
  const signature = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    vapid.signingKey,
    utf8(`${header}.${claims}`),
  )
  return `${header}.${claims}.${encode(signature)}`
}

/** RFC 8292 §3: the Authorization header's value. */
export const vapidAuthorization = (jwt: string, publicKey: Uint8Array) => `vapid t=${jwt}, k=${encode(publicKey)}`

export interface VapidEnv {
  VAPID_PUBLIC_KEY?: string
  VAPID_PRIVATE_KEY?: string
  VAPID_SUBJECT?: string
}

/** Key pairs already checked, by their text: each is parsed, imported and checked once per isolate. */
const checked = new Map<string, Promise<Omit<Vapid, "subject"> | undefined>>()

/** Parses and imports the pair, and checks the public key is the private key's: a signature must verify. */
async function check(publicText: string, privateText: string): Promise<Omit<Vapid, "subject"> | undefined> {
  const keys = parseKeyPair({ publicKey: publicText, privateKey: privateText })
  if (!keys) {
    console.error("VAPID_PUBLIC_KEY or VAPID_PRIVATE_KEY isn't a P-256 key in Web Push's encoding: push is off")
    return undefined
  }
  try {
    const signingKey = await importPrivate(keys.publicKey, keys.privateKey, "ECDSA")
    const probe = utf8("campflare vapid check")
    const signature = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, signingKey, probe)
    const verified = await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      await importPublic(keys.publicKey, "ECDSA"),
      signature,
      probe,
    )
    if (verified) return { publicKey: keys.publicKey, signingKey }
  } catch {
    // Not a usable key: said below.
  }
  console.error("VAPID_PUBLIC_KEY doesn't match VAPID_PRIVATE_KEY: push is off")
  return undefined
}

/**
 * The server's VAPID keys, checked, and its contact (VAPID_SUBJECT, else the
 * origin); undefined when push isn't configured, or is misconfigured (said once
 * in the log). Cached per isolate, so pushes don't parse or import keys.
 */
export async function loadVapid(env: VapidEnv, origin: string): Promise<Vapid | undefined> {
  const publicText = env.VAPID_PUBLIC_KEY?.trim()
  const privateText = env.VAPID_PRIVATE_KEY?.trim()
  if (!publicText || !privateText) return undefined
  const key = `${publicText} ${privateText}`
  let keys = checked.get(key)
  if (!keys) {
    keys = check(publicText, privateText)
    checked.set(key, keys)
  }
  const loaded = await keys
  return loaded && { ...loaded, subject: env.VAPID_SUBJECT?.trim() || origin }
}
