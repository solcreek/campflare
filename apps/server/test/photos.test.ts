import { SELF } from "cloudflare:test"
import { env } from "cloudflare:workers"
import { afterEach, describe, expect, it } from "vitest"
import { displaySize, imageSize, jpegOrientation } from "../src/api/media"
import { photoJson, photoTransforms, photoType, photoVariantOf } from "../src/api/photos"
import { setImagesOverride } from "../src/api/thumbs"
import { ORIGIN, connect, eventually, ok, workspace, type Body } from "./helpers"
import { convert, makeGif, makePng } from "./images"

// Profile photos: users.setPhoto / users.deletePhoto, and their sizes served
// at /avatars/<user>/<photo>_<size>.<ext>, without a token, as the initials are.

afterEach(() => setImagesOverride(undefined))

type Profile = Record<string, unknown> & { image_72: string; image_original?: string; avatar_hash: string }

async function setPhoto(token: string, bytes: Uint8Array<ArrayBuffer>, args: Record<string, string> = {}) {
  const form = new FormData()
  form.set("image", new File([bytes], "me.png"))
  for (const [k, v] of Object.entries(args)) form.set(k, v)
  const res = await SELF.fetch(`${ORIGIN}/api/users.setPhoto`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
    body: form,
  })
  return (await res.json()) as Body & { profile: Profile }
}

async function profileOf(token: string) {
  return (await ok<{ profile: Profile }>("users.profile.get", {}, token)).profile
}

const sizeOf = async (res: Response) => imageSize(new Uint8Array(await res.arrayBuffer()))

describe("users.setPhoto", () => {
  it("draws the initials until there's a photo, at every Slack size", async () => {
    const w = await workspace()
    const profile = await profileOf(w.owner.token)
    for (const n of [24, 32, 48, 72, 192, 512, 1024]) {
      expect(profile[`image_${n}`]).toBe(`${ORIGIN}/avatars/${w.owner.id}?s=${n}`)
    }
    expect(profile.image_original).toBeUndefined()
    expect(profile.is_custom_image).toBeUndefined()
  })

  it("serves the photo's sizes as squares, with no token, cached for good", async () => {
    const w = await workspace()
    const rtm = await ok<{ url: string }>("rtm.connect", {}, w.owner.token)
    const link = await connect(rtm.url)
    await link.next((f) => f.type === "hello")
    const before = await profileOf(w.owner.token)
    const png = await makePng(600, 400)
    const set = await setPhoto(w.owner.token, png)
    expect(set.ok).toBe(true)
    const p = set.profile
    expect(p.is_custom_image).toBe(true)
    expect(p.avatar_hash).not.toBe(before.avatar_hash)
    expect(p.image_72).toMatch(new RegExp(`^${ORIGIN}/avatars/${w.owner.id}/[0-9a-f]+_72\\.png$`))
    expect(p.image_original).toMatch(/_original\.png$/)
    const change = await link.next((f) => f.type === "user_change")
    expect(change).toMatchObject({ user: { id: w.owner.id, profile: { image_72: p.image_72 } } })
    link.close()

    const res = await SELF.fetch(p.image_72)
    expect(res.status).toBe(200)
    expect(res.headers.get("content-type")).toBe("image/png")
    expect(res.headers.get("cache-control")).toContain("immutable")
    expect(res.headers.get("content-security-policy")).toBe("sandbox")
    expect(await sizeOf(res)).toEqual({ width: 72, height: 72 })
    // The second fetch is the one R2 kept.
    const again = await SELF.fetch(p.image_72)
    expect(again.headers.get("etag")).toBeTruthy()
    expect(await sizeOf(again)).toEqual({ width: 72, height: 72 })
    expect(await sizeOf(await SELF.fetch(p.image_1024 as string))).toEqual({ width: 1024, height: 1024 })
    const original = await SELF.fetch(p.image_original!)
    expect(new Uint8Array(await original.arrayBuffer())).toEqual(png)

    // users.info and users.list carry it too.
    const info = await ok<{ user: { profile: Profile } }>("users.info", { user: w.owner.id }, w.owner.token)
    expect(info.user.profile.image_72).toBe(p.image_72)
  })

  it("gives a new photo new URLs, and forgets the old one", async () => {
    const w = await workspace()
    const first = (await setPhoto(w.owner.token, await makePng(300, 300))).profile
    expect((await SELF.fetch(first.image_72)).status).toBe(200)
    const second = (await setPhoto(w.owner.token, await makePng(200, 200))).profile
    expect(second.image_72).not.toBe(first.image_72)
    expect((await SELF.fetch(first.image_72)).status).toBe(404)
    expect((await SELF.fetch(second.image_72)).status).toBe(200)
    // Everything under the old photo's prefix is gone: the original and the size made from it.
    const prefix = `${w.teamId}/avatars/${w.owner.id}/`
    await eventually(async () =>
      (await env.FILES.list({ prefix })).objects.every((o) => o.key.includes(photoOf(second))),
    )
    const left = (await env.FILES.list({ prefix })).objects.map((o) => o.key.slice(prefix.length))
    expect(left.toSorted()).toEqual([`${photoOf(second)}/72`, `${photoOf(second)}/original`])
  })

  it("takes back a size made while the photo was being replaced", async () => {
    const w = await workspace()
    const p = (await setPhoto(w.owner.token, await makePng(120, 120))).profile
    // The photo is deleted while Images is still making image_48.
    setImagesOverride(racingImages(() => ok("users.deletePhoto", {}, w.owner.token)))
    expect((await SELF.fetch(p.image_48 as string)).status).toBe(200)
    const prefix = `${w.teamId}/avatars/${w.owner.id}/`
    await eventually(async () => (await env.FILES.list({ prefix })).objects.length === 0)
  })

  it("keeps JPEG as JPEG", async () => {
    const w = await workspace()
    const jpeg = await convert(env.IMAGES!, await makePng(320, 240), "image/jpeg")
    const p = (await setPhoto(w.owner.token, jpeg)).profile
    expect(p.image_48).toMatch(/_48\.jpg$/)
    expect(p.image_original).toMatch(/_original\.jpg$/)
    const res = await SELF.fetch(p.image_48 as string)
    expect(res.headers.get("content-type")).toBe("image/jpeg")
    expect(await sizeOf(res)).toEqual({ width: 48, height: 48 })
  })

  it("serves the original for every size without the Images binding, or when it fails", async () => {
    const w = await workspace()
    const p = (await setPhoto(w.owner.token, await makePng(260, 180))).profile
    setImagesOverride(null)
    const plain = await SELF.fetch(p.image_72)
    expect(plain.headers.get("cache-control")).not.toContain("immutable")
    expect(await sizeOf(plain)).toEqual({ width: 260, height: 180 })
    setImagesOverride(failingImages())
    expect(await sizeOf(await SELF.fetch(p.image_192 as string))).toEqual({ width: 260, height: 180 })
    // Nothing was kept: with Images back, the size is made.
    setImagesOverride(undefined)
    expect(await sizeOf(await SELF.fetch(p.image_72))).toEqual({ width: 72, height: 72 })
  })

  it("crops to the square it's given before sizing", async () => {
    const w = await workspace()
    const calls: ImageTransform[][] = []
    setImagesOverride(recordingImages(calls))
    const p = (await setPhoto(w.owner.token, await makePng(400, 300), { crop_x: "50", crop_y: "20", crop_w: "250" }))
      .profile
    expect(await sizeOf(await SELF.fetch(p.image_32 as string))).toEqual({ width: 32, height: 32 })
    expect(calls).toEqual([
      [{ trim: { left: 50, top: 20, width: 250, height: 250 } }, { width: 32, height: 32, fit: "cover" }],
    ])
    const outside = await setPhoto(w.owner.token, await makePng(400, 300), { crop_x: "200", crop_w: "250" })
    expect(outside.error).toBe("invalid_arguments")
  })

  it("takes the crop in the upright photo's coordinates, after a JPEG's EXIF orientation", async () => {
    const w = await workspace()
    const stored = await convert(env.IMAGES!, await makePng(400, 300), "image/jpeg")
    // Turned a quarter: people see it 300 wide and 400 high.
    const turned = withOrientation(stored, 6)
    expect(jpegOrientation(turned)).toBe(6)
    const tall = { crop_x: "0", crop_y: "100", crop_w: "300" }
    expect((await setPhoto(w.owner.token, turned, tall)).ok).toBe(true)
    expect((await setPhoto(w.owner.token, stored, tall)).error).toBe("invalid_arguments")
    const wide = { crop_x: "100", crop_y: "0", crop_w: "300" }
    expect((await setPhoto(w.owner.token, stored, wide)).ok).toBe(true)
    expect((await setPhoto(w.owner.token, turned, wide)).error).toBe("invalid_arguments")
  })

  it("refuses what isn't a still image, and needs users.profile:write on a person's token", async () => {
    const w = await workspace()
    const res = await SELF.fetch(`${ORIGIN}/api/users.setPhoto`, {
      method: "POST",
      headers: { authorization: `Bearer ${w.owner.token}` },
      body: new FormData(),
    })
    expect(await res.json()).toMatchObject({ ok: false, error: "bad_image" })
    const text = new Uint8Array(new TextEncoder().encode("¿Qué? 你好 — not an image"))
    expect((await setPhoto(w.owner.token, text)).error).toBe("bad_image")
    expect((await setPhoto(w.owner.token, makeGif(64, 64, 3))).error).toBe("too_many_frames")
    // A still GIF is fine; its sizes are PNG.
    const still = (await setPhoto(w.owner.token, makeGif(64, 64, 1))).profile
    expect(still.image_72).toMatch(/_72\.png$/)
    expect(still.image_original).toMatch(/_original\.gif$/)

    const reader = (await ok<{ token: string }>("campflare.tokens.create", { preset: "read" }, w.owner.token)).token
    expect((await setPhoto(reader, await makePng(64, 64))).error).toBe("missing_scope")
    const bot = await w.addApp("Fotobot")
    expect((await setPhoto(bot.botToken, await makePng(64, 64))).error).toBe("not_allowed_token_type")
  })
})

describe("users.deletePhoto", () => {
  it("brings the initials back and tells everyone", async () => {
    const w = await workspace()
    await ok("users.deletePhoto", {}, w.owner.token)
    const p = (await setPhoto(w.owner.token, await makePng(128, 128))).profile
    const rtm = await ok<{ url: string }>("rtm.connect", {}, w.owner.token)
    const link = await connect(rtm.url)
    await link.next((f) => f.type === "hello")
    await ok("users.deletePhoto", {}, w.owner.token)
    const change = await link.next((f) => f.type === "user_change")
    expect(change).toMatchObject({ user: { profile: { image_72: `${ORIGIN}/avatars/${w.owner.id}?s=72` } } })
    link.close()
    expect((await profileOf(w.owner.token)).is_custom_image).toBeUndefined()
    expect((await SELF.fetch(p.image_72)).status).toBe(404)
    expect((await SELF.fetch(p.image_original!)).status).toBe(404)
  })
})

describe("photo URLs", () => {
  const u = { id: "U1", team_id: "T1", photo: "abc123", photo_type: "image/webp", photo_crop: null }

  it("name one size of one photo", () => {
    expect(photoVariantOf(u, "abc123_72.png")).toBe(72)
    expect(photoVariantOf(u, "abc123_original.webp")).toBe("original")
    expect(photoVariantOf(u, "abc123_72.jpg")).toBeUndefined()
    expect(photoVariantOf(u, "abc123_73.png")).toBeUndefined()
    expect(photoVariantOf(u, "abc123_original.png")).toBeUndefined()
    expect(photoVariantOf(u, "other_72.png")).toBeUndefined()
    expect(photoVariantOf({ ...u, photo: null }, "abc123_72.png")).toBeUndefined()
    expect(photoJson("https://x.test", { ...u, photo: null })).toBeUndefined()
    expect(photoJson("https://x.test", u)).toMatchObject({
      image_24: "https://x.test/avatars/U1/abc123_24.png",
      image_original: "https://x.test/avatars/U1/abc123_original.webp",
    })
    expect(photoTransforms(null, 48)).toEqual([{ width: 48, height: 48, fit: "cover" }])
    expect(photoType(new Uint8Array([1, 2, 3]))).toBeUndefined()
  })

  it("answer 404 for anything else", async () => {
    const w = await workspace()
    expect((await SELF.fetch(`${ORIGIN}/avatars/UNOPE/abc_72.png`)).status).toBe(404)
    expect((await SELF.fetch(`${ORIGIN}/avatars/${w.owner.id}/abc_72.png`)).status).toBe(404)
    const p = (await setPhoto(w.owner.token, await makePng(64, 64))).profile
    // The row names a photo whose bytes are gone (deleted behind its back).
    await env.FILES.delete(`${w.teamId}/avatars/${w.owner.id}/${photoOf(p)}/original`)
    expect((await SELF.fetch(p.image_original!)).status).toBe(404)
    expect((await SELF.fetch(p.image_512 as string)).status).toBe(404)
    setImagesOverride(null)
    expect((await SELF.fetch(p.image_24 as string)).status).toBe(404)
  })
})

describe("status_expiration", () => {
  it("reads an expired status as none, and tells everyone of a profile change", async () => {
    const w = await workspace()
    const bob = await w.addUser("bob")
    const rtm = await ok<{ url: string }>("rtm.connect", {}, bob.token)
    const link = await connect(rtm.url)
    await link.next((f) => f.type === "hello")
    const later = Math.floor(Date.now() / 1000) + 3600
    const set = await ok<{ profile: Profile }>(
      "users.profile.set",
      { profile: { status_text: "En réunion · 会議中", status_emoji: ":calendar:", status_expiration: later } },
      w.owner.token,
    )
    expect(set.profile).toMatchObject({ status_text: "En réunion · 会議中", status_expiration: later })
    const change = await link.next((f) => f.type === "user_change")
    expect(change).toMatchObject({ user: { id: w.owner.id, profile: { status_emoji: ":calendar:" } } })
    link.close()

    await ok("users.profile.set", { name: "status_expiration", value: "1000" }, w.owner.token)
    const info = await ok<{ user: { profile: Profile } }>("users.info", { user: w.owner.id }, bob.token)
    expect(info.user.profile).toMatchObject({ status_text: "", status_emoji: "", status_expiration: 0 })
    // Without an expiry it stays.
    await ok("users.profile.set", { profile: { status_text: "회의 중", status_expiration: 0 } }, w.owner.token)
    expect(await profileOf(w.owner.token)).toMatchObject({ status_text: "회의 중", status_emoji: ":calendar:" })
  })
})

/** A JPEG with an EXIF APP1 segment, right after SOI, giving this orientation. */
function withOrientation(jpeg: Uint8Array, orientation: number, little = false): Uint8Array<ArrayBuffer> {
  const u16 = (n: number) => (little ? [n & 0xff, n >> 8] : [n >> 8, n & 0xff])
  const u32 = (n: number) => (little ? [n, 0, 0, 0] : [0, 0, 0, n])
  const tiff = [
    ...(little ? [0x49, 0x49] : [0x4d, 0x4d]),
    ...u16(42),
    ...u32(8),
    ...u16(1), // one entry
    ...u16(0x0112),
    ...u16(3), // SHORT
    ...u32(1),
    ...u16(orientation),
    0,
    0,
    ...u32(0), // no next IFD
  ]
  const payload = [...new TextEncoder().encode("Exif\0\0"), ...tiff]
  const app1 = [0xff, 0xe1, (payload.length + 2) >> 8, (payload.length + 2) & 0xff, ...payload]
  return new Uint8Array([0xff, 0xd8, ...app1, ...jpeg.subarray(2)])
}

describe("EXIF orientation", () => {
  it("reads it from either byte order, and is 1 without one", async () => {
    const jpeg = await convert(env.IMAGES!, await makePng(40, 30), "image/jpeg")
    expect(jpegOrientation(jpeg)).toBe(1)
    expect(jpegOrientation(withOrientation(jpeg, 8, true))).toBe(8)
    expect(jpegOrientation(withOrientation(jpeg, 3))).toBe(3)
    expect(jpegOrientation(withOrientation(jpeg, 42))).toBe(1)
    expect(jpegOrientation(await makePng(4, 4))).toBe(1)
    expect(displaySize(withOrientation(jpeg, 5), { width: 40, height: 30 })).toEqual({ width: 30, height: 40 })
    expect(displaySize(withOrientation(jpeg, 2), { width: 40, height: 30 })).toEqual({ width: 40, height: 30 })
    // An Exif segment with no orientation entry.
    const other = withOrientation(jpeg, 6)
    other[22] = 0x10 // SOI, APP1 header, "Exif\0\0", TIFF header, count: the tag 0x0112 becomes 0x1012
    expect(jpegOrientation(other)).toBe(1)
  })
})

const photoOf = (p: Profile) => /\/([0-9a-f]+)_72\./.exec(p.image_72)![1]

/** The real binding, recording each output's transforms. */
function recordingImages(calls: ImageTransform[][]): ImagesBinding {
  const real = env.IMAGES!
  return {
    info: (stream: ReadableStream<Uint8Array>) => real.info(stream),
    input(stream: ReadableStream<Uint8Array>) {
      const transforms: ImageTransform[] = []
      const transformer = {
        transform(t: ImageTransform) {
          transforms.push(t)
          return transformer
        },
        draw: () => transformer,
        output(output: ImageOutputOptions) {
          calls.push(transforms)
          return transforms.reduce((t, x) => t.transform(x), real.input(stream)).output(output)
        },
      }
      return transformer
    },
  } as unknown as ImagesBinding
}

/** The real binding, running `meanwhile` before handing back each output. */
function racingImages(meanwhile: () => Promise<unknown>): ImagesBinding {
  const real = env.IMAGES!
  return {
    info: (stream: ReadableStream<Uint8Array>) => real.info(stream),
    input(stream: ReadableStream<Uint8Array>) {
      const transforms: ImageTransform[] = []
      const transformer = {
        transform(t: ImageTransform) {
          transforms.push(t)
          return transformer
        },
        draw: () => transformer,
        async output(output: ImageOutputOptions) {
          const out = await transforms.reduce((t, x) => t.transform(x), real.input(stream)).output(output)
          await meanwhile()
          return out
        },
      }
      return transformer
    },
  } as unknown as ImagesBinding
}

function failingImages(): ImagesBinding {
  const transformer = {
    transform: () => transformer,
    draw: () => transformer,
    output: () => Promise.reject(new Error("ERROR 9412: Bad input")),
  }
  return { info: () => Promise.reject(new Error("bad")), input: () => transformer } as unknown as ImagesBinding
}
