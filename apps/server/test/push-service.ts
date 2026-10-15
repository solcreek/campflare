import { concat, decode, encode, utf8 } from "../src/push/base64url"
import { generateKeyPair, type KeyPair } from "../src/push/keys"
import { setPushFetch } from "../src/push/send"

// A browser's side of Web Push and a push service, for the tests: subscriptions
// with real keys, and a fake service that records what the server sends and
// decrypts it the way a browser would (written from RFC 8291, not from src/push).

export interface FakeSubscription {
  endpoint: string
  keys: { p256dh: string; auth: string }
  /** The browser's private side. */
  ua: KeyPair
}

let next = 0

/** A browser's PushSubscription.toJSON(), at a service of the fake's. */
export async function browserSubscription(host = "push.example"): Promise<FakeSubscription> {
  const ua = await generateKeyPair()
  const auth = encode(crypto.getRandomValues(new Uint8Array(16)))
  return { endpoint: `https://${host}/send/${++next}-${crypto.randomUUID()}`, keys: { p256dh: ua.publicKey, auth }, ua }
}

const b64 = (s: string) => decode(s)!

async function hkdf(
  salt: Uint8Array<ArrayBuffer>,
  ikm: Uint8Array<ArrayBuffer>,
  info: Uint8Array<ArrayBuffer>,
  n: number,
) {
  const key = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"])
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, key, n * 8))
}

/** Decrypts an aes128gcm push body as the browser holding `sub` would. */
export async function decryptPush(body: Uint8Array<ArrayBuffer>, sub: Pick<FakeSubscription, "ua" | "keys">) {
  const salt = body.slice(0, 16)
  const idlen = body[20]!
  const asPublic = body.slice(21, 21 + idlen)
  const uaPoint = b64(sub.ua.publicKey)
  const priv = await crypto.subtle.importKey(
    "jwk",
    { kty: "EC", crv: "P-256", x: encode(uaPoint.slice(1, 33)), y: encode(uaPoint.slice(33)), d: sub.ua.privateKey },
    { name: "ECDH", namedCurve: "P-256" },
    false,
    ["deriveBits"],
  )
  const pub = await crypto.subtle.importKey("raw", asPublic, { name: "ECDH", namedCurve: "P-256" }, false, [])
  const shared = new Uint8Array(
    await crypto.subtle.deriveBits(
      { name: "ECDH", public: pub } as unknown as SubtleCryptoDeriveKeyAlgorithm,
      priv,
      256,
    ),
  )
  const ikm = await hkdf(b64(sub.keys.auth), shared, concat(utf8("WebPush: info\0"), uaPoint, asPublic), 32)
  const cek = await hkdf(salt, ikm, utf8("Content-Encoding: aes128gcm\0"), 16)
  const nonce = await hkdf(salt, ikm, utf8("Content-Encoding: nonce\0"), 12)
  const key = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["decrypt"])
  const padded = new Uint8Array(
    await crypto.subtle.decrypt({ name: "AES-GCM", iv: nonce }, key, body.slice(21 + idlen)),
  )
  let end = padded.length - 1
  while (padded[end] === 0) end--
  if (padded[end] !== 2) throw new Error("not the last record")
  return new TextDecoder().decode(padded.slice(0, end))
}

export interface PushHit {
  endpoint: string
  headers: Headers
  body: Uint8Array<ArrayBuffer>
}

/**
 * Stands in for push services (setPushFetch): records every push and answers
 * `answer` (201 by default). Like fakeRequestUrls(), next() polls rather than
 * being woken by the push, which arrives in the hub's waitUntil work.
 */
export function fakePushService() {
  const hits: PushHit[] = []
  const fake = {
    hits,
    answer: (_hit: PushHit): Response | Promise<Response> => new Response(null, { status: 201 }),
    async next(test: (h: PushHit) => boolean = () => true, timeoutMs = 2000): Promise<PushHit> {
      const deadline = Date.now() + timeoutMs
      for (;;) {
        const seen = hits.find(test)
        if (seen) {
          hits.splice(hits.indexOf(seen), 1)
          return seen
        }
        if (Date.now() > deadline) throw new Error(`no matching push; got ${hits.map((h) => h.endpoint).join(", ")}`)
        await new Promise((r) => setTimeout(r, 5))
      }
    },
    /** The push to a subscription, decrypted. */
    async payload(sub: FakeSubscription, timeoutMs?: number) {
      const hit = await fake.next((h) => h.endpoint === sub.endpoint, timeoutMs)
      return { hit, payload: JSON.parse(await decryptPush(hit.body, sub)) as Record<string, unknown> }
    },
    restore: () => setPushFetch(undefined),
  }
  setPushFetch(async (input, init) => {
    const hit = {
      endpoint: String(input),
      headers: new Headers(init?.headers),
      body: new Uint8Array(init?.body as Uint8Array<ArrayBuffer>),
    }
    hits.push(hit)
    return fake.answer(hit)
  })
  return fake
}
