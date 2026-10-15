import { describe, expect, it } from "vitest"
import { ApiError, apiBase, createClient, type Fetch } from "../src/index"

type Seen = { url: string; init?: RequestInit }

function fakeFetch(responses: (Response | ((seen: Seen) => Response))[]) {
  const seen: Seen[] = []
  const fetch: Fetch = async (input, init) => {
    const entry = { url: String(input), init }
    seen.push(entry)
    const next = responses.shift()
    if (!next) throw new Error(`unexpected request to ${entry.url}`)
    return typeof next === "function" ? next(entry) : next
  }
  return { fetch, seen }
}

const json = (body: unknown, init: ResponseInit = {}) => Response.json(body, init)
const limited = () => new Response("", { status: 429, headers: { "retry-after": "2" } })

describe("apiBase", () => {
  it("accepts a host with or without /api and slashes", () => {
    expect(apiBase("https://x.test")).toBe("https://x.test/api/")
    expect(apiBase("https://x.test/")).toBe("https://x.test/api/")
    expect(apiBase("https://x.test/api")).toBe("https://x.test/api/")
  })
})

describe("call", () => {
  it("posts form-encoded args with a Bearer token", async () => {
    const { fetch, seen } = fakeFetch([json({ ok: true, user_id: "U1" })])
    const client = createClient({ url: "https://x.test", token: "xoxp-1", fetch })
    const res = await client.call("auth.test", { a: "b", n: 1, o: { k: 1 }, skip: undefined, nil: null })
    expect(res.user_id).toBe("U1")
    expect(seen[0]!.url).toBe("https://x.test/api/auth.test")
    expect((seen[0]!.init!.headers as Record<string, string>).authorization).toBe("Bearer xoxp-1")
    expect(String(seen[0]!.init!.body)).toBe("a=b&n=1&o=%7B%22k%22%3A1%7D")
  })

  it("posts multipart when an arg is a file", async () => {
    const { fetch, seen } = fakeFetch([json({ ok: true }), json({ ok: true })])
    const client = createClient({ url: "https://x.test", token: "xoxp-1", fetch })
    await client.call("users.setPhoto", { image: new File([new Uint8Array([1, 2])], "me.png"), crop_w: 2 })
    const body = seen[0]!.init!.body as FormData
    expect(body).toBeInstanceOf(FormData)
    expect((body.get("image") as File).name).toBe("me.png")
    expect(body.get("crop_w")).toBe("2")
    await client.call("users.setPhoto", { image: new Blob([new Uint8Array([1])]), meta: { a: 1 } })
    const second = seen[1]!.init!.body as FormData
    expect((second.get("image") as File).name).toBe("image")
    expect(second.get("meta")).toBe('{"a":1}')
  })

  it("throws ApiError with Slack's code", async () => {
    const { fetch } = fakeFetch([json({ ok: false, error: "channel_not_found" })])
    const client = createClient({ url: "https://x.test", fetch })
    const error = await client.call("chat.postMessage").catch((e: unknown) => e)
    expect(error).toBeInstanceOf(ApiError)
    expect(error).toMatchObject({ code: "channel_not_found", method: "chat.postMessage" })
  })

  it("reports a non-JSON answer by status, and an error without a code", async () => {
    const { fetch } = fakeFetch([new Response("oops", { status: 502 }), json({ ok: false })])
    const client = createClient({ url: "https://x.test", fetch })
    await expect(client.call("a.b")).rejects.toMatchObject({ code: "http_502" })
    await expect(client.call("a.b")).rejects.toMatchObject({ code: "unknown_error" })
  })

  it("waits out 429s, then gives up", async () => {
    const waits: number[] = []
    const sleep = async (ms: number) => void waits.push(ms)
    const { fetch } = fakeFetch([limited(), json({ ok: true })])
    await createClient({ url: "https://x.test", fetch, sleep }).call("a.b")
    expect(waits).toEqual([2000])
    const again = fakeFetch([limited(), limited()])
    await expect(
      createClient({ url: "https://x.test", fetch: again.fetch, sleep, maxRetries: 1 }).call("a.b"),
    ).rejects.toMatchObject({
      code: "http_429",
    })
  })

  it("uses the real timer and fetch by default", async () => {
    const { fetch } = fakeFetch([
      new Response("", { status: 429, headers: { "retry-after": "0" } }),
      json({ ok: true }),
    ])
    await createClient({ url: "https://x.test", fetch }).call("a.b")
    const original = globalThis.fetch
    globalThis.fetch = fakeFetch([json({ ok: true, via: "global" })]).fetch as typeof globalThis.fetch
    try {
      expect(await createClient({ url: "https://x.test" }).call("a.b")).toMatchObject({ via: "global" })
    } finally {
      globalThis.fetch = original
    }
  })
})

describe("paginate", () => {
  it("follows cursors", async () => {
    const { fetch, seen } = fakeFetch([
      json({ ok: true, members: [1, 2], response_metadata: { next_cursor: "c2" } }),
      json({ ok: true, members: [3], response_metadata: { next_cursor: "" } }),
      json({ ok: true }),
    ])
    const client = createClient({ url: "https://x.test", fetch })
    expect(await client.paginate("users.list", "members")).toEqual([1, 2, 3])
    expect(String(seen[1]!.init!.body)).toContain("cursor=c2")
    expect(await client.paginate("users.list", "members")).toEqual([])
  })
})

describe("upload", () => {
  it("reserves, posts the bytes, and completes", async () => {
    const { fetch, seen } = fakeFetch([
      json({ ok: true, upload_url: "https://x.test/upload/v1/abc", file_id: "F1" }),
      new Response("OK - 3"),
      json({ ok: true }),
    ])
    const client = createClient({ url: "https://x.test", token: "t", fetch })
    let uploaded: unknown
    const files = await client.upload([{ name: "a.txt", bytes: new Uint8Array([1, 2, 3]) }], {
      channel: "C1",
      text: "hi",
      // Before files.completeUploadExternal is sent.
      onUploaded: (ids) => (uploaded = [ids, seen.length]),
    })
    expect(files).toEqual([{ id: "F1", title: "a.txt" }])
    expect(uploaded).toEqual([[{ id: "F1", title: "a.txt" }], 2])
    expect(seen[1]!.url).toBe("https://x.test/upload/v1/abc")
    const complete = new URLSearchParams(String(seen[2]!.init!.body))
    expect(JSON.parse(complete.get("files")!)).toEqual([{ id: "F1", title: "a.txt" }])
    expect(complete.get("channel_id")).toBe("C1")
    expect(complete.get("initial_comment")).toBe("hi")
  })

  it("fails when the bytes are refused", async () => {
    const { fetch } = fakeFetch([
      json({ ok: true, upload_url: "https://x.test/u", file_id: "F1" }),
      new Response("", { status: 403 }),
    ])
    const client = createClient({ url: "https://x.test", fetch })
    await expect(client.upload([{ name: "a", bytes: new Uint8Array(1) }])).rejects.toThrow(
      "uploading a failed: HTTP 403",
    )
  })
})

describe("fetchFile", () => {
  it("sends the token to the server's files and its subdomains only", async () => {
    const { fetch, seen } = fakeFetch([new Response("png"), new Response("pdf")])
    const client = createClient({ url: "https://x.test/api", token: "xoxp-1", fetch })
    const res = await client.fetchFile("https://x.test/files-pri/T1-F1/a.png", { headers: { range: "bytes=0-1" } })
    expect(await res.text()).toBe("png")
    expect(seen[0]!.init!.headers).toEqual({ range: "bytes=0-1", authorization: "Bearer xoxp-1" })
    await client.fetchFile("https://files.x.test/files-pri/T1-F2/b.pdf")
    expect(seen[1]!.url).toBe("https://files.x.test/files-pri/T1-F2/b.pdf")

    await expect(client.fetchFile("https://evil.test/x")).rejects.toThrow("not a file on https://x.test")
    await expect(client.fetchFile("http://files.x.test/x")).rejects.toThrow("not a file")
    await expect(client.fetchFile("https://notx.test/x")).rejects.toThrow("not a file")
    expect(seen).toHaveLength(2)
  })
})

describe("authTest", () => {
  it("answers auth.test with the token's scopes from its x-oauth-scopes", async () => {
    const { fetch, seen } = fakeFetch([
      json({ ok: true, user_id: "U1" }, { headers: { "x-oauth-scopes": "chat:write,channels:read" } }),
      json({ ok: true }),
      json({ ok: false, error: "invalid_auth" }),
    ])
    const client = createClient({ url: "https://x.test", token: "xoxp-1", fetch })
    expect(await client.authTest()).toEqual({ ok: true, user_id: "U1", scopes: ["chat:write", "channels:read"] })
    expect(seen[0]!.url).toBe("https://x.test/api/auth.test")
    expect((await client.authTest()).scopes).toEqual([])
    await expect(client.authTest()).rejects.toBeInstanceOf(ApiError)
  })
})
