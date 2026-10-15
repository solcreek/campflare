import { decode, encode } from "./base64url"

// P-256 keys as Web Push writes them: a public key is the uncompressed point
// (0x04 || x || y, 65 bytes), a private key its scalar d (32 bytes), both
// base64url. WebCrypto takes the private one as a JWK.

/** Whether bytes are an uncompressed P-256 point (by shape: WebCrypto checks the curve on import). */
export const isPoint = (bytes: Uint8Array | undefined): bytes is Uint8Array<ArrayBuffer> =>
  bytes?.length === 65 && bytes[0] === 4

export function importPublic(point: Uint8Array<ArrayBuffer>, algorithm: "ECDH" | "ECDSA"): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    point,
    { name: algorithm, namedCurve: "P-256" },
    true,
    algorithm === "ECDSA" ? ["verify"] : [],
  )
}

export function importPrivate(point: Uint8Array, d: Uint8Array, algorithm: "ECDH" | "ECDSA"): Promise<CryptoKey> {
  const jwk: JsonWebKey = {
    kty: "EC",
    crv: "P-256",
    x: encode(point.slice(1, 33)),
    y: encode(point.slice(33, 65)),
    d: encode(d),
  }
  return crypto.subtle.importKey(
    "jwk",
    jwk,
    { name: algorithm, namedCurve: "P-256" },
    false,
    algorithm === "ECDSA" ? ["sign"] : ["deriveBits"],
  )
}

export interface KeyPair {
  /** The uncompressed point, base64url. */
  publicKey: string
  /** d, base64url. */
  privateKey: string
}

/** A fresh pair in Web Push's encoding: what `pnpm vapid-keys` prints. */
export async function generateKeyPair(): Promise<KeyPair> {
  const pair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair
  const raw = (await crypto.subtle.exportKey("raw", pair.publicKey)) as ArrayBuffer
  const jwk = (await crypto.subtle.exportKey("jwk", pair.privateKey)) as JsonWebKey
  return { publicKey: encode(raw), privateKey: jwk.d! }
}

export interface KeyBytes {
  publicKey: Uint8Array<ArrayBuffer>
  privateKey: Uint8Array<ArrayBuffer>
}

/** The pair's bytes, or undefined if either is missing or isn't a P-256 key in Web Push's encoding. */
export function parseKeyPair(pair: Partial<KeyPair>): KeyBytes | undefined {
  const publicKey = pair.publicKey ? decode(pair.publicKey.trim()) : undefined
  const privateKey = pair.privateKey ? decode(pair.privateKey.trim()) : undefined
  if (!isPoint(publicKey) || privateKey?.length !== 32) return undefined
  return { publicKey, privateKey }
}
