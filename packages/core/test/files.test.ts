import { afterEach, describe, expect, it, vi } from "vitest"
import { createFileCache, fileKind, fileLabel, fitImage, formatBytes } from "../src/files"

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
