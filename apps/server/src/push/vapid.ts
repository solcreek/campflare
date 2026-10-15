import { encode, utf8 } from "./base64url"
import { importPrivate, type KeyBytes } from "./keys"

// VAPID (RFC 8292): the server identifies itself to a push service with a JWT
// signed by its key (ES256), sent with the public key on every push.

/** How long a JWT is good for: push services refuse more than 24 hours. */
export const JWT_LIFETIME_S = 12 * 60 * 60

export interface Vapid extends KeyBytes {
  /** A mailto: or https: contact for the push service's operators. */
  subject: string
}

/** A signed JWT for one push service: its origin is the audience. */
export async function vapidJwt(vapid: Vapid, audience: string, now = Math.floor(Date.now() / 1000)): Promise<string> {
  const header = encode(utf8(JSON.stringify({ typ: "JWT", alg: "ES256" })))
  const claims = encode(utf8(JSON.stringify({ aud: audience, exp: now + JWT_LIFETIME_S, sub: vapid.subject })))
  const key = await importPrivate(vapid.publicKey, vapid.privateKey, "ECDSA")
  // WebCrypto's ECDSA signature is r || s, 64 bytes: what JWS wants for ES256.
  const signature = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, utf8(`${header}.${claims}`))
  return `${header}.${claims}.${encode(signature)}`
}

/** RFC 8292 §3: the Authorization header's value. */
export const vapidAuthorization = (jwt: string, publicKey: Uint8Array) => `vapid t=${jwt}, k=${encode(publicKey)}`
