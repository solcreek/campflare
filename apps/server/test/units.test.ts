import { describe, expect, it } from "vitest"
import { Args, decodeCursor, encodeCursor } from "../src/api/args"
import { sign, verify } from "../src/api/crypto"
import { CampflareError } from "../src/api/errors"
import { microsToTs, nextTs, normalizeTs, randomId, tsToMicros } from "../src/api/ids"
import { imageSize, mimeOf } from "../src/api/media"
import { ftsString, indexable, likePattern, parseSearch } from "../src/api/search-query"
import { issueTicket, readTicket } from "../src/api/tickets"

describe("ids and timestamps", () => {
  it("shapes ids like Slack's", () => {
    expect(randomId("C")).toMatch(/^C[0-9A-Z]{10}$/)
  })

  it("issues increasing fixed-width timestamps", () => {
    const a = nextTs()
    const b = nextTs()
    expect(a).toMatch(/^\d{10}\.\d{6}$/)
    expect(b > a).toBe(true)
    expect(nextTs(b) > b).toBe(true)
  })

  it("normalises client timestamps", () => {
    expect(normalizeTs("1727500000.0001")).toBe("1727500000.000100")
    expect(normalizeTs("1727500000")).toBe("1727500000.000000")
    expect(normalizeTs("abc")).toBeUndefined()
    expect(microsToTs(tsToMicros("0000000001.000002"))).toBe("0000000001.000002")
  })
})

const args = (values: Record<string, unknown>) => new Args(values)
const day = (y: number, m: number, d: number) => Date.UTC(y, m - 1, d) / 1000
const riff = (chunk: string, body: number[]) =>
  new Uint8Array([...new TextEncoder().encode(`RIFF\0\0\0\0WEBP${chunk}`), ...body, ...Array<number>(20).fill(0)])

describe("Args", () => {
  it("reads typed values", () => {
    const a = args({
      s: "x",
      n: "5",
      b: "true",
      one: 1,
      list: "a, b,,c",
      arr: ["x", 2],
      j: '{"k":1}',
      o: { k: 2 },
      t: true,
    })
    expect(a.str("s")).toBe("x")
    expect(a.str("t")).toBe("true")
    expect(a.str("o")).toBeUndefined()
    expect(a.int("n", 0)).toBe(5)
    expect(a.int("missing", 7)).toBe(7)
    expect(a.int("n", 0, { max: 3 })).toBe(3)
    expect(a.bool("b")).toBe(true)
    expect(a.bool("one")).toBe(true)
    expect(a.bool("t")).toBe(true)
    expect(a.bool("missing", true)).toBe(true)
    expect(a.list("list")).toEqual(["a", "b", "c"])
    expect(a.list("arr")).toEqual(["x", "2"])
    expect(a.list("missing")).toEqual([])
    expect(a.json("j")).toEqual({ k: 1 })
    expect(a.json("o")).toEqual({ k: 2 })
    expect(a.json("missing")).toBeUndefined()
    expect(a.has("s")).toBe(true)
    expect(a.file("s")).toBeUndefined()
  })

  it("throws Slack's errors for bad values", () => {
    expect(() => args({ n: "x" }).int("n", 0)).toThrow(CampflareError)
    expect(() => args({ j: "{" }).json("j")).toThrow("invalid_arguments")
    expect(() => args({ j: "{" }).json("j", "invalid_blocks")).toThrow("invalid_blocks")
    expect(() => args({}).req("x")).toThrow("invalid_arguments")
    expect(() => args({}).req("x", "no_text")).toThrow("no_text")
    expect(() => args({ t: "nope" }).ts("t")).toThrow("invalid_arguments")
  })

  it("parses multipart forms", async () => {
    const form = new FormData()
    form.set("a", "1")
    form.set("f", new File(["x"], "x.txt"))
    const a = await Args.from(new Request("https://x/api/m?q=2", { method: "POST", body: form }))
    expect(a.str("a")).toBe("1")
    expect(a.str("q")).toBe("2")
    expect(a.file("f")?.name).toBe("x.txt")
  })

  it("rejects a JSON body that isn't an object", async () => {
    const req = new Request("https://x/api/m", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "[1]",
    })
    await expect(Args.from(req)).rejects.toThrow("invalid_json")
  })

  it("round-trips cursors", () => {
    expect(decodeCursor(encodeCursor("C123"))).toBe("C123")
    expect(decodeCursor(undefined)).toBeUndefined()
    expect(() => decodeCursor(btoa("other"))).toThrow("invalid_cursor")
  })
})

describe("search syntax", () => {
  const now = Date.UTC(2026, 9, 11, 12) / 1000

  it("splits words, phrases, exclusions and modifiers", () => {
    expect(parseSearch('deploy "release notes" -flaky -"not this" in:#dev from:@bob has:link is:thread', now)).toEqual({
      terms: ["deploy", "release notes"],
      excluded: ["flaky", "not this"],
      in: ["#dev"],
      from: ["@bob"],
      has: ["link"],
      is: ["thread"],
    })
  })

  it("turns dates into bounds", () => {
    expect(parseSearch("before:2026-01-02", now)).toMatchObject({ until: day(2026, 1, 2) })
    expect(parseSearch("after:2026-01-02", now)).toMatchObject({ since: day(2026, 1, 3) })
    expect(parseSearch("on:2026-01-02", now)).toMatchObject({ since: day(2026, 1, 2), until: day(2026, 1, 3) })
    expect(parseSearch("during:2026-02", now)).toMatchObject({ since: day(2026, 2, 1), until: day(2026, 3, 1) })
    expect(parseSearch("on:today", now)).toMatchObject({ since: day(2026, 10, 11) })
    expect(parseSearch("on:yesterday", now)).toMatchObject({ since: day(2026, 10, 10) })
    // Not a date: kept as a word.
    expect(parseSearch("before:lunch", now).terms).toEqual(["before:lunch"])
    expect(parseSearch('""', now).terms).toEqual([])
  })

  it("escapes for FTS and LIKE", () => {
    expect(ftsString('say "hi"')).toBe('"say ""hi"""')
    expect(likePattern("50%_off\\")).toBe("%50\\%\\_off\\\\%")
    // Characters, not bytes or UTF-16 units: CJK, Hangul and accented Latin alike.
    for (const short of ["東京", "배포", "ño", "é"]) expect(indexable(short)).toBe(false)
    for (const long of ["東京都", "배포가", "año", "été", "abc"]) expect(indexable(long)).toBe(true)
  })
})

describe("media", () => {
  it("guesses mime types from names", () => {
    expect(mimeOf("a.PNG")).toBe("image/png")
    expect(mimeOf("noext")).toBe("application/octet-stream")
  })

  it("reads image sizes from headers", () => {
    const gif = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 10, 0, 20, 0])
    expect(imageSize(gif)).toEqual({ width: 10, height: 20 })
    // JPEG: SOI, an APP0 segment, then SOF0 with height 0x0102, width 0x0304.
    const jpeg = new Uint8Array([
      0xff, 0xd8, 0xff, 0xe0, 0, 4, 0, 0, 0xff, 0xc0, 0, 17, 8, 0x01, 0x02, 0x03, 0x04, 0, 0, 0,
    ])
    expect(imageSize(jpeg)).toEqual({ width: 0x0304, height: 0x0102 })
    expect(imageSize(new Uint8Array([0xff, 0xd8, 0x00, 0x00, 0, 0, 0, 0, 0, 0, 0, 0]))).toBeUndefined()
    const vp8 = riff("VP8 ", [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 100, 0, 50, 0])
    expect(imageSize(vp8)).toEqual({ width: 100, height: 50 })
    const vp8x = riff("VP8X", [0, 0, 0, 0, 0, 0, 0, 0, 9, 0, 0, 4, 0, 0])
    expect(imageSize(vp8x)).toEqual({ width: 10, height: 5 })
    // VP8L packs width-1 and height-1 into 14-bit fields after a signature byte.
    const bits = 99 | (49 << 14)
    const vp8l = riff("VP8L", [
      0,
      0,
      0,
      0,
      0x2f,
      bits & 0xff,
      (bits >> 8) & 0xff,
      (bits >> 16) & 0xff,
      (bits >> 24) & 0xff,
    ])
    expect(imageSize(vp8l)).toEqual({ width: 100, height: 50 })
    expect(imageSize(new Uint8Array([1, 2, 3]))).toBeUndefined()
  })
})

describe("signing and tickets", () => {
  it("verifies only untampered values", async () => {
    const signed = await sign("k", "payload")
    expect(await verify("k", signed)).toBe("payload")
    expect(await verify("other", signed)).toBeUndefined()
    expect(await verify("k", `${signed}0`)).toBeUndefined()
    expect(await verify("k", "nodot")).toBeUndefined()
  })

  it("reads back tickets until they expire", async () => {
    const ticket = await issueTicket("k", { kind: "rtm", teamId: "T1", users: ["U1"] })
    expect(await readTicket("k", ticket)).toMatchObject({ kind: "rtm", teamId: "T1", users: ["U1"] })
    expect(await readTicket("k", await sign("k", btoa("not json")))).toBeUndefined()
    const expired = await sign("k", btoa(JSON.stringify({ expires: 1 })).replace(/=+$/, ""))
    expect(await readTicket("k", expired)).toBeUndefined()
  })
})

describe("publicOrigin", () => {
  it("keeps the request's origin, unless a TLS-terminating proxy says the client used https", async () => {
    const { publicOrigin } = await import("../src/api/origin")
    const at = (headers: Record<string, string> = {}, url = "http://chat.example.com/api/x") =>
      publicOrigin(new Request(url, { headers }))
    expect(at()).toBe("http://chat.example.com")
    expect(at({ "x-forwarded-proto": "https" })).toBe("https://chat.example.com")
    expect(at({ "x-forwarded-proto": "https, http" })).toBe("https://chat.example.com")
    expect(at({ "cf-visitor": '{"scheme":"https"}' })).toBe("https://chat.example.com")
    expect(at({ "cf-visitor": "not json" })).toBe("http://chat.example.com")
    expect(at({ "x-forwarded-proto": "http" })).toBe("http://chat.example.com")
    // Never downgraded: an https request stays https.
    expect(at({ "x-forwarded-proto": "http" }, "https://chat.example.com/")).toBe("https://chat.example.com")
    expect(at({ "x-forwarded-proto": "https" }, "http://localhost:8787/")).toBe("https://localhost:8787")
  })
})
