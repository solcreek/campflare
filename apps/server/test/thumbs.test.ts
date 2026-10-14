import { SELF } from "cloudflare:test"
import { env } from "cloudflare:workers"
import { afterEach, describe, expect, it } from "vitest"
import { imageSize } from "../src/api/media"
import { fittedSize, setImagesOverride, thumbSizes, thumbsJson, thumbVariantOf, thumbVariants } from "../src/api/thumbs"
import type { FileRow } from "../src/db/rows"
import { ok, workspace } from "./helpers"
import { convert, makeGif, makePng } from "./images"

// The Images binding runs locally (Miniflare resizes with sharp), so these
// tests make real thumbnails; setImagesOverride() stands in for a failing
// binding or none at all.

afterEach(() => setImagesOverride(undefined))

type FileJson = Record<string, unknown> & { id: string; url_private: string }

async function share(token: string, channel: string, name: string, bytes: Uint8Array) {
  const reserved = await ok<{ upload_url: string; file_id: string }>(
    "files.getUploadURLExternal",
    { filename: name, length: bytes.length },
    token,
  )
  expect((await SELF.fetch(reserved.upload_url, { method: "POST", body: bytes })).status).toBe(200)
  await ok("files.completeUploadExternal", { files: [{ id: reserved.file_id }], channel_id: channel }, token)
  return (await ok<{ file: FileJson }>("files.info", { file: reserved.file_id }, token)).file
}

const get = (url: string, token: string, headers: Record<string, string> = {}) =>
  SELF.fetch(url, { headers: { authorization: `Bearer ${token}`, ...headers } })

async function sizeOf(res: Response) {
  return imageSize(new Uint8Array(await res.arrayBuffer()))
}

const row = (over: Partial<FileRow>): FileRow =>
  ({
    id: "F1",
    team_id: "T1",
    name: "photo.png",
    mimetype: "image/png",
    width: 1600,
    height: 1200,
    animated: 0,
    ...over,
  }) as FileRow

describe("thumbnail sizes", () => {
  it("follows Slack: the squares and thumb_360 always, larger ones only below the original", () => {
    expect(thumbSizes(row({}))).toEqual([64, 80, 160, 360, 480, 720, 800, 960, 1024])
    expect(thumbSizes(row({ width: 700, height: 300 }))).toEqual([64, 80, 160, 360, 480])
    expect(thumbSizes(row({ width: 176, height: 226 }))).toEqual([64, 80, 160, 360])
    expect(thumbSizes(row({ width: 1024, height: 768 }))).toEqual([64, 80, 160, 360, 480, 720, 800, 960])
    expect(thumbSizes(row({ mimetype: "image/svg+xml" }))).toEqual([])
    expect(thumbSizes(row({ mimetype: "application/pdf" }))).toEqual([])
    expect(thumbSizes(row({ width: null, height: null }))).toEqual([])
  })

  it("scales down to fit, never up", () => {
    expect(fittedSize(360, 1600, 1200)).toEqual({ width: 360, height: 270 })
    expect(fittedSize(360, 600, 2400)).toEqual({ width: 90, height: 360 })
    expect(fittedSize(360, 176, 226)).toEqual({ width: 176, height: 226 })
    expect(fittedSize(360, 10_000, 1)).toEqual({ width: 360, height: 1 })
  })

  it("names thumbnails after the file, with _w and _h from 360 up", () => {
    const json = thumbsJson("https://x.test", row({ name: "my photo.jpeg", mimetype: "image/jpeg" }), true)
    expect(json.thumb_64).toBe("https://x.test/files-tmb/T1-F1/my%20photo_64.jpg")
    expect(json.thumb_64_w).toBeUndefined()
    expect(json.thumb_160_w).toBeUndefined()
    expect(json).toMatchObject({ thumb_360_w: 360, thumb_360_h: 270, thumb_1024_w: 1024, thumb_1024_h: 768 })
    expect(thumbsJson("https://x.test", row({ name: "диаграмма.gif", mimetype: "image/gif" }), true).thumb_80).toBe(
      `https://x.test/files-tmb/T1-F1/${encodeURIComponent("диаграмма_80.png")}`,
    )
    expect(thumbsJson("https://x.test", row({ name: ".png" }), true).thumb_80).toBe(
      "https://x.test/files-tmb/T1-F1/image_80.png",
    )
    expect(thumbsJson("https://x.test", row({}), false)).toEqual({})
    expect(thumbVariantOf("a_b_360.png")).toBe("360")
    expect(thumbVariantOf("a_64.jpg")).toBe("64")
    expect(thumbVariantOf("a_361.png")).toBeUndefined()
    expect(thumbVariantOf("a_360.svg")).toBeUndefined()
  })

  it("adds Slack's thumb_360_gif, thumb_480_gif and deanimate_gif for animated images", () => {
    const moving = row({ name: "baile.gif", mimetype: "image/gif", width: 400, height: 300, animated: 1 })
    expect(thumbVariants(moving)).toEqual(["64", "80", "160", "360", "360_gif", "deanimate_gif"])
    const json = thumbsJson("https://x.test", moving, true)
    expect(json).toMatchObject({
      thumb_360: "https://x.test/files-tmb/T1-F1/baile_360.png",
      thumb_360_gif: "https://x.test/files-tmb/T1-F1/baile_360.gif",
      thumb_360_w: 360,
      thumb_360_h: 270,
      deanimate_gif: "https://x.test/files-tmb/T1-F1/baile_deanimate_gif.png",
    })
    expect(json.thumb_480_gif).toBeUndefined()
    // thumb_480_gif comes with thumb_480; there's no larger GIF.
    const big = row({ mimetype: "image/gif", animated: 1 })
    expect(thumbVariants(big)).toEqual([...thumbSizes(big).map(String), "360_gif", "480_gif", "deanimate_gif"])
    // An animated WebP's are GIFs too; a still GIF, or a GIF of unknown size, has none.
    expect(thumbVariants(row({ mimetype: "image/webp", animated: 1 }))).toContain("480_gif")
    expect(thumbVariants(row({ mimetype: "image/gif", animated: 0 }))).not.toContain("360_gif")
    expect(thumbVariants(row({ mimetype: "image/gif", animated: 1, width: null }))).toEqual([])
    // Uploaded before animation was recorded: a GIF counts as animated, other images don't.
    expect(thumbVariants(row({ mimetype: "image/gif", animated: null }))).toContain("deanimate_gif")
    expect(thumbVariants(row({ animated: null }))).not.toContain("deanimate_gif")
    expect(thumbVariantOf("baile_360.gif")).toBe("360_gif")
    expect(thumbVariantOf("baile_480.gif")).toBe("480_gif")
    expect(thumbVariantOf("baile_720.gif")).toBeUndefined()
    expect(thumbVariantOf("baile_deanimate_gif.png")).toBe("deanimate_gif")
    expect(thumbVariantOf("baile_deanimate_gif.jpg")).toBeUndefined()
  })
})

describe("thumbnails", () => {
  it("know at upload whether an image moves", async () => {
    const w = await workspace()
    const files = [
      await share(w.owner.token, w.general, "still.gif", makeGif(40, 30, 1, { loop: true })),
      await share(w.owner.token, w.general, "moving.gif", makeGif(40, 30, 3)),
      await share(w.owner.token, w.general, "photo.png", await makePng(40, 30)),
      await share(w.owner.token, w.general, "notes.txt", new TextEncoder().encode("Grüße, 你好")),
    ]
    const rows = await env.DB.prepare("SELECT name, animated FROM files WHERE id IN (?, ?, ?, ?) ORDER BY created, id")
      .bind(...files.map((f) => f.id))
      .all<{ name: string; animated: number | null }>()
    expect(Object.fromEntries(rows.results.map((r) => [r.name, r.animated]))).toEqual({
      "still.gif": 0,
      "moving.gif": 1,
      "photo.png": 0,
      "notes.txt": null,
    })
  })

  it("are made on first fetch, kept in R2, and served like url_private", async () => {
    const w = await workspace()
    const bob = await w.addUser("bob")
    const carol = await w.addUser("carol")
    const { channel } = await ok<{ channel: { id: string } }>(
      "conversations.create",
      { name: "photos", is_private: true },
      w.owner.token,
    )
    await ok("conversations.invite", { channel: channel.id, users: bob.id }, w.owner.token)
    const file = await share(w.owner.token, channel.id, "sunset.png", await makePng(1200, 900))
    expect(file).toMatchObject({
      original_w: 1200,
      original_h: 900,
      thumb_360_w: 360,
      thumb_360_h: 270,
      thumb_480_w: 480,
      thumb_480_h: 360,
      thumb_1024_w: 1024,
      thumb_1024_h: 768,
    })
    for (const size of [64, 80, 160, 360, 480, 720, 800, 960, 1024]) {
      expect(file[`thumb_${size}`]).toMatch(new RegExp(`/files-tmb/${w.teamId}-${file.id}/sunset_${size}\\.png$`))
    }
    // Message files carry them too.
    const history = await ok<{ messages: { files: FileJson[] }[] }>(
      "conversations.history",
      { channel: channel.id },
      bob.token,
    )
    expect(history.messages[0]!.files[0]!.thumb_360).toBe(file.thumb_360)
    const listed = await ok<{ files: FileJson[] }>("files.list", { channel: channel.id }, bob.token)
    expect(listed.files[0]!.thumb_720).toBe(file.thumb_720)

    const url = file.thumb_360 as string
    expect(await env.FILES.head(`${w.teamId}/${file.id}/thumb_360`)).toBeNull()
    const first = await get(url, bob.token)
    expect(first.status).toBe(200)
    expect(first.headers.get("content-type")).toBe("image/png")
    expect(first.headers.get("content-disposition")).toBe("inline; filename*=UTF-8''sunset_360.png")
    expect(first.headers.get("content-security-policy")).toBe("sandbox")
    expect(first.headers.get("x-content-type-options")).toBe("nosniff")
    expect(await sizeOf(first)).toEqual({ width: 360, height: 270 })
    const stored = await env.FILES.head(`${w.teamId}/${file.id}/thumb_360`)
    expect(stored?.httpMetadata?.contentType).toBe("image/png")

    // Served from R2 from now on: a broken binding no longer matters.
    setImagesOverride(failingImages())
    const again = await get(url, bob.token)
    expect(await sizeOf(again)).toEqual({ width: 360, height: 270 })
    const ranged = await get(url, bob.token, { range: "bytes=0-7" })
    expect(ranged.status).toBe(206)
    expect(ranged.headers.get("content-range")).toBe(`bytes 0-7/${stored!.size}`)
    expect((await ranged.arrayBuffer()).byteLength).toBe(8)
    const unchanged = await get(url, bob.token, { "if-none-match": stored!.httpEtag })
    expect(unchanged.status).toBe(304)
    setImagesOverride(undefined)

    // The squares: 64 cropped, 80 padded.
    expect(await sizeOf(await get(file.thumb_64 as string, bob.token))).toEqual({ width: 64, height: 64 })
    expect(await sizeOf(await get(file.thumb_80 as string, bob.token))).toEqual({ width: 80, height: 80 })
    expect(await sizeOf(await get(file.thumb_1024 as string, bob.token))).toEqual({ width: 1024, height: 768 })

    // Who may see the file may see its thumbnails; nobody else.
    expect((await get(url, carol.token)).status).toBe(404)
    expect((await SELF.fetch(url)).status).toBe(401)
    expect((await get(url, "xoxp-nope")).status).toBe(401)
    // Sizes the file doesn't have, and names that aren't thumbnails.
    const base = url.replace(/[^/]+$/, "")
    for (const name of ["sunset_1100.png", "sunset_9999.png", "sunset.png", "sunset_360.svg"]) {
      expect((await get(`${base}${name}`, bob.token)).status).toBe(404)
    }
    expect((await get(`${base.replace(file.id, "FNOPE")}sunset_360.png`, bob.token)).status).toBe(404)

    // Deleting the file deletes its thumbnails.
    await ok("files.delete", { file: file.id }, w.owner.token)
    expect(await env.FILES.head(`${w.teamId}/${file.id}/thumb_360`)).toBeNull()
    expect(await env.FILES.head(`${w.teamId}/${file.id}/thumb_64`)).toBeNull()
  })

  it("answer CORS for browser apps, as url_private does", async () => {
    const w = await workspace()
    const file = await share(w.owner.token, w.general, "pic.png", await makePng(500, 400))
    const pre = await SELF.fetch(file.thumb_360 as string, {
      method: "OPTIONS",
      headers: {
        origin: "https://app.example",
        "access-control-request-method": "GET",
        "access-control-request-headers": "authorization",
      },
    })
    expect(pre.status).toBe(204)
    expect(pre.headers.get("access-control-allow-origin")).toBe("*")
    expect(pre.headers.get("access-control-allow-credentials")).toBeNull()
    const res = await get(file.thumb_360 as string, w.owner.token, { origin: "https://app.example" })
    expect(res.headers.get("access-control-allow-origin")).toBe("*")
    expect(await sizeOf(res)).toEqual({ width: 360, height: 288 })
  })

  it("give animated GIFs moving ones: GIFs from Images, else the original", async () => {
    const w = await workspace()
    const bytes = makeGif(500, 400, 2)
    const file = await share(w.owner.token, w.general, "動き.gif", bytes)
    const base = `/files-tmb/${w.teamId}-${file.id}/`
    expect(file).toMatchObject({
      original_w: 500,
      original_h: 400,
      thumb_360_w: 360,
      thumb_360_h: 288,
      thumb_480_w: 480,
      thumb_480_h: 384,
    })
    expect(file.thumb_360_gif).toContain(`${base}${encodeURIComponent("動き_360.gif")}`)
    expect(file.thumb_480_gif).toContain(`${base}${encodeURIComponent("動き_480.gif")}`)
    expect(file.deanimate_gif).toContain(`${base}${encodeURIComponent("動き_deanimate_gif.png")}`)
    expect(file.thumb_720_gif).toBeUndefined()
    expect(file.thumb_360).toMatch(/_360\.png$/)

    // Local Images can't write GIF: the original stands in, uncached.
    const local = await get(file.thumb_360_gif as string, w.owner.token)
    expect(local.headers.get("content-type")).toBe("image/gif")
    expect(new Uint8Array(await local.arrayBuffer())).toEqual(bytes)
    expect(await env.FILES.head(`${w.teamId}/${file.id}/thumb_360_gif`)).toBeNull()

    // Real Images writes an animated GIF, which R2 keeps.
    const calls: { transforms: ImageTransform[]; output: ImageOutputOptions }[] = []
    setImagesOverride(gifWritingImages(calls))
    const made = await get(file.thumb_480_gif as string, w.owner.token)
    expect(made.headers.get("content-type")).toBe("image/gif")
    expect(made.headers.get("content-disposition")).toBe(
      `inline; filename*=UTF-8''${encodeURIComponent("動き_480.gif")}`,
    )
    expect(await sizeOf(made)).toEqual({ width: 480, height: 384 })
    expect(calls).toEqual([
      { transforms: [{ width: 480, height: 480, fit: "scale-down" }], output: { format: "image/gif", anim: true } },
    ])
    expect((await env.FILES.head(`${w.teamId}/${file.id}/thumb_480_gif`))?.httpMetadata?.contentType).toBe("image/gif")
    // The stills ask Images for no animation.
    await get(file.thumb_360 as string, w.owner.token)
    expect(calls[1]!.output).toEqual({ format: "image/png", anim: false })
    setImagesOverride(undefined)

    // deanimate_gif: the first frame at full size, as a PNG.
    const still = await get(file.deanimate_gif as string, w.owner.token)
    expect(still.headers.get("content-type")).toBe("image/png")
    expect(await sizeOf(still)).toEqual({ width: 500, height: 400 })

    await ok("files.delete", { file: file.id }, w.owner.token)
    for (const key of ["thumb_480_gif", "deanimate_gif", "thumb_360"]) {
      expect(await env.FILES.head(`${w.teamId}/${file.id}/${key}`)).toBeNull()
    }
  })

  it("serve a small animated GIF as its own thumb_360_gif, and give still GIFs none", async () => {
    const w = await workspace()
    const bytes = makeGif(176, 226, 3)
    const small = await share(w.owner.token, w.general, "danse.gif", bytes)
    expect(small).toMatchObject({ thumb_360_w: 176, thumb_360_h: 226 })
    expect(small.thumb_480_gif).toBeUndefined()
    // No Images involved: even a failing binding serves it.
    setImagesOverride(failingImages())
    const res = await get(small.thumb_360_gif as string, w.owner.token)
    expect(res.headers.get("content-disposition")).toBe("inline; filename*=UTF-8''danse_360.gif")
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(bytes)
    setImagesOverride(undefined)

    const still = await share(w.owner.token, w.general, "plan.gif", makeGif(500, 400, 1, { loop: true }))
    expect(still.thumb_480).toMatch(/plan_480\.png$/)
    expect(Object.keys(still).filter((k) => k.endsWith("_gif"))).toEqual([])
    const base = (still.thumb_360 as string).replace(/[^/]+$/, "")
    expect((await get(`${base}plan_360.gif`, w.owner.token)).status).toBe(404)
    expect((await get(`${base}plan_deanimate_gif.png`, w.owner.token)).status).toBe(404)
  })

  it("keep JPEG as JPEG, and give GIFs a PNG of the first frame", async () => {
    const w = await workspace()
    const png = await makePng(800, 600)
    const jpeg = await share(w.owner.token, w.general, "plage.jpg", await convert(env.IMAGES!, png, "image/jpeg"))
    expect(jpeg.thumb_480).toMatch(/plage_480\.jpg$/)
    const res = await get(jpeg.thumb_480 as string, w.owner.token)
    expect(res.headers.get("content-type")).toBe("image/jpeg")
    expect(await sizeOf(res)).toEqual({ width: 480, height: 360 })

    const gif = await share(w.owner.token, w.general, "animación.gif", makeGif(400, 300, 2))
    expect(gif).toMatchObject({ original_w: 400, original_h: 300, thumb_360_w: 360, thumb_360_h: 270 })
    expect(gif.thumb_480).toBeUndefined()
    const thumb = await get(gif.thumb_360 as string, w.owner.token)
    expect(thumb.headers.get("content-type")).toBe("image/png")
    expect(await sizeOf(thumb)).toEqual({ width: 360, height: 270 })
    // The original keeps its animation for clients that want it.
    expect(new Uint8Array(await (await get(gif.url_private, w.owner.token)).arrayBuffer())).toEqual(
      makeGif(400, 300, 2),
    )
  })

  it("aren't offered for SVG or other files", async () => {
    const w = await workspace()
    const svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg" width="400" height="400"/>')
    const file = await share(w.owner.token, w.general, "logo.svg", svg)
    expect(Object.keys(file).filter((k) => k.startsWith("thumb_"))).toEqual([])
    const text = await share(w.owner.token, w.general, "notes.txt", new TextEncoder().encode("bonjour"))
    expect(Object.keys(text).filter((k) => k.startsWith("thumb_"))).toEqual([])
    const base = `https://campflare.test/files-tmb/${w.teamId}-${file.id}/logo_360.png`
    expect((await get(base, w.owner.token)).status).toBe(404)
  })

  it("are off without the Images binding: no thumb_*, and the route finds nothing", async () => {
    const w = await workspace()
    const on = await share(w.owner.token, w.general, "a.png", await makePng(400, 300))
    setImagesOverride(null)
    const off = await ok<{ file: FileJson }>("files.info", { file: on.id }, w.owner.token)
    expect(off.file).toMatchObject({ original_w: 400, original_h: 300 })
    expect(Object.keys(off.file).filter((k) => k.startsWith("thumb_"))).toEqual([])
    const history = await ok<{ messages: { files: FileJson[] }[] }>(
      "conversations.history",
      { channel: w.general },
      w.owner.token,
    )
    expect(history.messages[0]!.files[0]!.thumb_360).toBeUndefined()
    const listed = await ok<{ files: FileJson[] }>("files.list", {}, w.owner.token)
    expect(listed.files[0]!.thumb_360).toBeUndefined()
    expect((await get(on.thumb_360 as string, w.owner.token)).status).toBe(404)
  })

  it("fall back to the original, uncached, when Images fails on a file", async () => {
    const w = await workspace()
    const png = await makePng(600, 400)
    const file = await share(w.owner.token, w.general, "broken.png", png)
    setImagesOverride(failingImages())
    const res = await get(file.thumb_360 as string, w.owner.token)
    expect(res.status).toBe(200)
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(png)
    expect(await env.FILES.head(`${w.teamId}/${file.id}/thumb_360`)).toBeNull()
  })

  it("answer 404 when the original is gone from R2", async () => {
    const w = await workspace()
    const file = await share(w.owner.token, w.general, "gone.png", await makePng(400, 300))
    await env.FILES.delete(`${w.teamId}/${file.id}`)
    expect((await get(file.thumb_360 as string, w.owner.token)).status).toBe(404)
    expect((await get(file.url_private, w.owner.token)).status).toBe(404)
  })
})

/**
 * The local Images binding, except that it "writes" GIFs as real Images does: a two-frame GIF of
 * the size asked for, standing in for the resized animation. Records what it was asked.
 */
function gifWritingImages(calls: { transforms: ImageTransform[]; output: ImageOutputOptions }[]): ImagesBinding {
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
          calls.push({ transforms, output })
          if (output.format !== "image/gif") {
            return transforms.reduce((t, x) => t.transform(x), real.input(stream)).output(output)
          }
          const info = (await real.info(stream)) as { width: number; height: number }
          const { width, height } = fittedSize(transforms[0]?.width ?? 0, info.width, info.height)
          const bytes = makeGif(width, height, 2)
          return {
            response: () => new Response(bytes, { headers: { "content-type": "image/gif" } }),
            contentType: () => "image/gif",
            image: () => new Blob([bytes]).stream(),
          }
        },
      }
      return transformer
    },
  } as unknown as ImagesBinding
}

/** An Images binding that fails every transformation, as it does on a file it can't read. */
function failingImages(): ImagesBinding {
  const transformer = {
    transform: () => transformer,
    draw: () => transformer,
    output: () => Promise.reject(new Error("ERROR 9412: Bad input")),
  }
  return {
    info: () => Promise.reject(new Error("ERROR 9412: Bad input")),
    input: () => transformer,
  } as unknown as ImagesBinding
}
