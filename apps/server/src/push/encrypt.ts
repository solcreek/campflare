import { concat, utf8 } from "./base64url"
import { importPrivate, importPublic } from "./keys"

// Message encryption for Web Push (RFC 8291): the aes128gcm content coding
// (RFC 8188), keyed by ECDH between a one-off key of ours and the browser's
// subscription key (p256dh), mixed with its auth secret through HKDF.

/** The record size we declare: the payload always fits in one record. */
const RECORD_SIZE = 4096

/** Push services take 4096 bytes of body: the header (86), the tag (16) and the delimiter leave this much. */
export const MAX_PLAINTEXT = RECORD_SIZE - 86 - 16 - 1

export interface Recipient {
  /** The browser's public key (p256dh): an uncompressed P-256 point. */
  p256dh: Uint8Array<ArrayBuffer>
  /** Its auth secret, 16 bytes. */
  auth: Uint8Array<ArrayBuffer>
}

/** For the RFC's test vectors: our key pair and the salt, random otherwise. */
export interface Fixed {
  publicKey: Uint8Array<ArrayBuffer>
  privateKey: Uint8Array<ArrayBuffer>
  salt: Uint8Array<ArrayBuffer>
}

async function hkdf(
  salt: Uint8Array<ArrayBuffer>,
  ikm: Uint8Array<ArrayBuffer>,
  info: Uint8Array<ArrayBuffer>,
  bytes: number,
) {
  const key = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"])
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, key, bytes * 8))
}

async function ownKeys(fixed?: Fixed): Promise<{ publicKey: Uint8Array<ArrayBuffer>; privateKey: CryptoKey }> {
  if (fixed)
    return { publicKey: fixed.publicKey, privateKey: await importPrivate(fixed.publicKey, fixed.privateKey, "ECDH") }
  const pair = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, [
    "deriveBits",
  ])) as CryptoKeyPair
  const raw = (await crypto.subtle.exportKey("raw", pair.publicKey)) as ArrayBuffer
  return { publicKey: new Uint8Array(raw), privateKey: pair.privateKey }
}

/** The encrypted body for one subscription: salt, record size, our public key, then the one record. */
export async function encrypt(plaintext: Uint8Array, to: Recipient, fixed?: Fixed): Promise<Uint8Array<ArrayBuffer>> {
  if (plaintext.length > MAX_PLAINTEXT) throw new RangeError(`push payload over ${MAX_PLAINTEXT} bytes`)
  const own = await ownKeys(fixed)
  const theirs = await importPublic(to.p256dh, "ECDH")
  const shared = new Uint8Array(
    await crypto.subtle.deriveBits(
      { name: "ECDH", public: theirs } as unknown as SubtleCryptoDeriveKeyAlgorithm,
      own.privateKey,
      256,
    ),
  )
  // RFC 8291 §3.4: IKM = HKDF(auth_secret, ecdh_secret, "WebPush: info" || 0x00 || ua_public || as_public, 32).
  const ikm = await hkdf(to.auth, shared, concat(utf8("WebPush: info\0"), to.p256dh, own.publicKey), 32)
  const salt = fixed?.salt ?? crypto.getRandomValues(new Uint8Array(16))
  // RFC 8188 §2.2 and §2.3: the content encryption key and the nonce.
  const cek = await hkdf(salt, ikm, utf8("Content-Encoding: aes128gcm\0"), 16)
  const nonce = await hkdf(salt, ikm, utf8("Content-Encoding: nonce\0"), 12)
  const key = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"])
  // One record, the last: the delimiter 0x02 and no padding.
  const record = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: nonce },
    key,
    concat(plaintext, new Uint8Array([2])),
  )
  const header = new Uint8Array(16 + 4 + 1)
  header.set(salt, 0)
  new DataView(header.buffer).setUint32(16, RECORD_SIZE)
  header[20] = own.publicKey.length
  return concat(header, own.publicKey, new Uint8Array(record))
}
