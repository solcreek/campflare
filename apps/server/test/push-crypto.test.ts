import { describe, expect, it } from "vitest"
import { concat, decode, encode, utf8 } from "../src/push/base64url"
import { encrypt, MAX_PLAINTEXT } from "../src/push/encrypt"
import { generateKeyPair, importPublic, parseKeyPair } from "../src/push/keys"
import { JWT_LIFETIME_S, vapidAuthorization, vapidJwt } from "../src/push/vapid"

const b64 = (s: string) => decode(s)!

// RFC 8291, Appendix A: the example push message.
const RFC = {
  plaintext: "When I grow up, I want to be a watermelon",
  asPrivate: "yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw",
  asPublic: "BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8",
  uaPrivate: "q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94",
  uaPublic: "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4",
  auth: "BTBZMqHH6r4Tts7J_aSIgg",
  salt: "DGv6ra1nlYgDCS1FRnbzlw",
  body:
    "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_" +
    "yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN",
}

/** The browser's side, written from RFC 8291 and RFC 8188 independently of src/push: decrypts a body. */
async function decrypt(body: Uint8Array<ArrayBuffer>, ua: { publicKey: string; privateKey: string }, auth: string) {
  const salt = body.slice(0, 16)
  const idlen = body[20]!
  const asPublic = body.slice(21, 21 + idlen)
  const ciphertext = body.slice(21 + idlen)
  const uaPoint = b64(ua.publicKey)
  const priv = await crypto.subtle.importKey(
    "jwk",
    {
      kty: "EC",
      crv: "P-256",
      x: encode(uaPoint.slice(1, 33)),
      y: encode(uaPoint.slice(33)),
      d: ua.privateKey,
    },
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
  const hkdf = async (
    s: Uint8Array<ArrayBuffer>,
    ikm: Uint8Array<ArrayBuffer>,
    info: Uint8Array<ArrayBuffer>,
    n: number,
  ) =>
    new Uint8Array(
      await crypto.subtle.deriveBits(
        { name: "HKDF", hash: "SHA-256", salt: s, info },
        await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]),
        n * 8,
      ),
    )
  const ikm = await hkdf(b64(auth), shared, concat(utf8("WebPush: info\0"), uaPoint, asPublic), 32)
  const cek = await hkdf(salt, ikm, utf8("Content-Encoding: aes128gcm\0"), 16)
  const nonce = await hkdf(salt, ikm, utf8("Content-Encoding: nonce\0"), 12)
  const key = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["decrypt"])
  const padded = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: nonce }, key, ciphertext))
  let end = padded.length - 1
  while (padded[end] === 0) end--
  expect(padded[end]).toBe(2)
  return new TextDecoder().decode(padded.slice(0, end))
}

describe("base64url", () => {
  it("round-trips bytes, reads padded base64, and refuses what isn't", () => {
    const bytes = new Uint8Array([0, 251, 255, 62, 63, 1])
    expect(encode(bytes)).toBe("APv_Pj8B")
    expect(decode("APv_Pj8B")).toEqual(bytes)
    expect(decode("APv/Pj8B")).toEqual(bytes)
    expect(decode("AQ==")).toEqual(new Uint8Array([1]))
    expect(decode("not base64!")).toBeUndefined()
    expect(decode("A")).toBeUndefined()
  })
})

describe("message encryption (RFC 8291)", () => {
  it("reproduces the RFC's example message byte for byte", async () => {
    const body = await encrypt(
      utf8(RFC.plaintext),
      { p256dh: b64(RFC.uaPublic), auth: b64(RFC.auth) },
      { publicKey: b64(RFC.asPublic), privateKey: b64(RFC.asPrivate), salt: b64(RFC.salt) },
    )
    expect(encode(body)).toBe(RFC.body)
  })

  it("encrypts with a fresh key and salt each time, which the browser decrypts", async () => {
    const ua = await generateKeyPair()
    const auth = encode(crypto.getRandomValues(new Uint8Array(16)))
    const to = { p256dh: b64(ua.publicKey), auth: b64(auth) }
    const text = "¡Hola! Ça va? 你好 こんにちは 안녕하세요 Grüße"
    const [a, b] = await Promise.all([encrypt(utf8(text), to), encrypt(utf8(text), to)])
    expect(encode(a.slice(0, 16))).not.toBe(encode(b.slice(0, 16)))
    expect(new DataView(a.buffer).getUint32(16)).toBe(4096)
    expect(a[20]).toBe(65)
    expect(await decrypt(a, ua, auth)).toBe(text)
    expect(await decrypt(b, ua, auth)).toBe(text)
  })

  it("refuses a payload that won't fit one push", async () => {
    const ua = await generateKeyPair()
    const to = { p256dh: b64(ua.publicKey), auth: new Uint8Array(16) }
    await expect(encrypt(new Uint8Array(MAX_PLAINTEXT + 1), to)).rejects.toThrow(RangeError)
    const body = await encrypt(new Uint8Array(MAX_PLAINTEXT), to)
    expect(body.length).toBe(4096)
  })
})

describe("VAPID (RFC 8292)", () => {
  it("signs an ES256 JWT for the push service's origin that the public key verifies", async () => {
    const pair = await generateKeyPair()
    const keys = parseKeyPair(pair)!
    const now = 1_760_000_000
    const jwt = await vapidJwt({ ...keys, subject: "mailto:ops@campflare.test" }, "https://push.example", now)
    const [header, claims, signature] = jwt.split(".") as [string, string, string]
    expect(JSON.parse(new TextDecoder().decode(b64(header)))).toEqual({ typ: "JWT", alg: "ES256" })
    expect(JSON.parse(new TextDecoder().decode(b64(claims)))).toEqual({
      aud: "https://push.example",
      exp: now + JWT_LIFETIME_S,
      sub: "mailto:ops@campflare.test",
    })
    expect(b64(signature).length).toBe(64)
    const verified = await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      await importPublic(keys.publicKey, "ECDSA"),
      b64(signature),
      utf8(`${header}.${claims}`),
    )
    expect(verified).toBe(true)
    expect(vapidAuthorization(jwt, keys.publicKey)).toBe(`vapid t=${jwt}, k=${pair.publicKey}`)
  })

  it("parses keys in Web Push's encoding, and nothing else", async () => {
    const pair = await generateKeyPair()
    expect(b64(pair.publicKey).length).toBe(65)
    expect(b64(pair.privateKey).length).toBe(32)
    expect(parseKeyPair({ publicKey: ` ${pair.publicKey}\n`, privateKey: pair.privateKey })).toBeDefined()
    expect(parseKeyPair({ publicKey: pair.publicKey })).toBeUndefined()
    expect(parseKeyPair({ publicKey: pair.privateKey, privateKey: pair.privateKey })).toBeUndefined()
    expect(parseKeyPair({ publicKey: pair.publicKey, privateKey: pair.publicKey })).toBeUndefined()
  })
})
