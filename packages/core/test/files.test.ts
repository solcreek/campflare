import { afterEach, describe, expect, it, vi } from "vitest"
import { createFileCache, fileKind, fileLabel, fitImage, formatBytes, imageSource, pastedFileName } from "../src/files"

afterEach(() => {
  vi.useRealTimers()
})

describe("file helpers", () => {
  it("shows common raster images inline and everything else as a file", () => {
    const url = "https://x.test/files-pri/T1-F1/a"
    expect(fileKind({ id: "F1", mimetype: "image/png", url_private: url })).toBe("image")
    expect(fileKind({ id: "F1", mimetype: "image/webp", url_private: url })).toBe("image")
    // SVG can run script; a file without a URL can't be fetched.
    expect(fileKind({ id: "F1", mimetype: "image/svg+xml", url_private: url })).toBe("file")
    expect(fileKind({ id: "F1", mimetype: "image/png" })).toBe("file")
    expect(fileKind({ id: "F1", mimetype: "application/pdf", url_private: url })).toBe("file")
    expect(fileKind({ id: "F1" })).toBe("file")
    expect(fileKind({ id: "F1", mode: "tombstone" })).toBe("deleted")
  })

  it("labels a file by its alt text, title or name", () => {
    expect(fileLabel({ id: "F1", name: "café.png", title: "東京の夜", alt_txt: "Nachtansicht" })).toBe("Nachtansicht")
    expect(fileLabel({ id: "F1", name: "café.png", title: "서울 야경" })).toBe("서울 야경")
    expect(fileLabel({ id: "F1", name: "café.png", title: "" })).toBe("café.png")
    expect(fileLabel({ id: "F1" })).toBe("file")
  })

  it("formats sizes in binary units", () => {
    expect(formatBytes(0)).toBe("0 B")
    expect(formatBytes(1023)).toBe("1023 B")
    expect(formatBytes(1024)).toBe("1 KB")
    expect(formatBytes(1536)).toBe("1.5 KB")
    expect(formatBytes(20 * 1024 * 1024)).toBe("20 MB")
    expect(formatBytes(3 * 1024 ** 5)).toBe("3072 TB")
    expect(formatBytes(Number.NaN)).toBe("0 B")
  })

  it("fits an image in a box without enlarging it", () => {
    expect(fitImage({ id: "F1", original_w: 1600, original_h: 900 }, 400, 300)).toEqual({ width: 400, height: 225 })
    expect(fitImage({ id: "F1", original_w: 600, original_h: 1200 }, 400, 300)).toEqual({ width: 150, height: 300 })
    expect(fitImage({ id: "F1", original_w: 40, original_h: 20 }, 400, 300)).toEqual({ width: 40, height: 20 })
    expect(fitImage({ id: "F1", original_w: 10_000, original_h: 1 }, 400, 300)).toEqual({ width: 400, height: 1 })
    expect(fitImage({ id: "F1" }, 400, 300)).toEqual({ width: 400, height: 300 })
  })

  it("draws an image from the smallest thumbnail that covers its box", () => {
    const base = "https://x.test/files-tmb/T1-F1/photo"
    const photo = {
      id: "F1",
      mimetype: "image/jpeg",
      original_w: 1600,
      original_h: 900,
      url_private: "https://x.test/files-pri/T1-F1/photo.jpg",
      thumb_64: `${base}_64.jpg`,
      thumb_360: `${base}_360.jpg`,
      thumb_360_w: 360,
      thumb_360_h: 203,
      thumb_720: `${base}_720.jpg`,
      thumb_720_w: 720,
      thumb_720_h: 405,
      thumb_1024: `${base}_1024.jpg`,
      thumb_1024_w: 1024,
      thumb_1024_h: 576,
    }
    expect(imageSource(photo, 360, 203)).toBe(`${base}_360.jpg`)
    expect(imageSource(photo, 200, 113)).toBe(`${base}_360.jpg`)
    // Retina: twice the pixels.
    expect(imageSource(photo, 360, 203, 2)).toBe(`${base}_720.jpg`)
    expect(imageSource(photo, 360, 203, 2.5)).toBe(`${base}_1024.jpg`)
    // Bigger than any thumbnail: the original.
    expect(imageSource(photo, 1200, 675)).toBe(photo.url_private)
    expect(imageSource(photo, 360, 203, 3)).toBe(photo.url_private)

    // A small image's thumb_360 is its full size: good at any ratio.
    const small = {
      id: "F2",
      mimetype: "image/png",
      original_w: 176,
      original_h: 226,
      url_private: "https://x.test/files-pri/T1-F2/s.png",
      thumb_360: "https://x.test/files-tmb/T1-F2/s_360.png",
      thumb_360_w: 176,
      thumb_360_h: 226,
    }
    expect(imageSource(small, 176, 226, 2)).toBe(small.thumb_360)
    // No thumbnails (a server without them), or a GIF, whose thumbnails don't move.
    expect(imageSource({ ...small, thumb_360: undefined }, 176, 226)).toBe(small.url_private)
    expect(imageSource({ ...photo, mimetype: "image/gif" }, 360, 203)).toBe(photo.url_private)
  })

  it("names pasted files that came with a generic name", () => {
    const when = new Date(2026, 9, 2, 9, 5, 7)
    expect(pastedFileName("image.png", "image/png", when)).toBe("Pasted image 2026-10-02 at 09.05.07.png")
    expect(pastedFileName("Pasted Graphic 3.tiff", "image/jpeg", when, 1)).toBe(
      "Pasted image 2026-10-02 at 09.05.07 (2).jpg",
    )
    expect(pastedFileName("", "image/heic", when)).toBe("Pasted image 2026-10-02 at 09.05.07")
    expect(pastedFileName("blob", "application/octet-stream", when)).toBe("Pasted file 2026-10-02 at 09.05.07")
    expect(pastedFileName("image.TIFF", "image/tiff", when)).toBe("Pasted image 2026-10-02 at 09.05.07.tiff")
    // A real name stays, in any script.
    expect(pastedFileName("東京タワー.png", "image/png", when)).toBe("東京タワー.png")
    expect(pastedFileName("서울.jpg", "image/jpeg", when)).toBe("서울.jpg")
    expect(pastedFileName("Größe-año.webp", "image/webp", when)).toBe("Größe-año.webp")
  })
})

function harness(responses: Record<string, () => Response | Promise<Response>>) {
  const fetched: string[] = []
  const live = new Set<string>()
  let n = 0
  const cache = createFileCache({
    fetchFile: async (url) => {
      fetched.push(url)
      const make = responses[url]
      if (!make) throw new TypeError("network down")
      return make()
    },
    createObjectURL: () => {
      const u = `blob:${++n}`
      live.add(u)
      return u
    },
    revokeObjectURL: (u) => live.delete(u),
    graceMs: 100,
  })
  return { cache, fetched, live }
}

describe("createFileCache", () => {
  it("fetches once for every holder and revokes after the last lets go", async () => {
    vi.useFakeTimers()
    const { cache, fetched, live } = harness({ a: () => new Response("png") })
    const [one, two] = await Promise.all([cache.acquire("a"), cache.acquire("a")])
    expect(one).toBe("blob:1")
    expect(two).toBe("blob:1")
    expect(fetched).toEqual(["a"])
    cache.release("a")
    await vi.advanceTimersByTimeAsync(500)
    expect(live.has("blob:1")).toBe(true)
    cache.release("a")
    cache.release("a") // one too many: ignored
    cache.release("never")
    // A remount within the grace period keeps the same URL.
    await vi.advanceTimersByTimeAsync(50)
    expect(await cache.acquire("a")).toBe("blob:1")
    cache.release("a")
    await vi.advanceTimersByTimeAsync(100)
    expect(live.size).toBe(0)
    expect(await cache.acquire("a")).toBe("blob:2")
    expect(fetched).toEqual(["a", "a"])
  })

  it("doesn't cache a failure, and fails on HTTP errors", async () => {
    const { cache, fetched } = harness({ gone: () => new Response("no", { status: 404 }) })
    await expect(cache.acquire("gone")).rejects.toThrow("fetching gone failed: HTTP 404")
    await expect(cache.acquire("offline")).rejects.toThrow("network down")
    await expect(cache.acquire("offline")).rejects.toThrow("network down")
    expect(fetched).toEqual(["gone", "offline", "offline"])
  })

  it("hands out uncached blobs and revokes everything on clear", async () => {
    const { cache, fetched, live } = harness({ a: () => new Response("aa"), b: () => new Response("bbb") })
    expect(await (await cache.blob("b")).text()).toBe("bbb")
    await cache.acquire("a")
    await cache.acquire("b")
    cache.release("b")
    expect(live.size).toBe(2)
    cache.clear()
    await Promise.resolve()
    expect(live.size).toBe(0)
    expect(fetched).toEqual(["b", "a", "b"])
  })

  it("uses the platform's object URLs by default", async () => {
    const cache = createFileCache({ fetchFile: async () => new Response("x") })
    const url = await cache.acquire("a")
    expect(url).toMatch(/^blob:/)
    cache.clear()
  })
})
