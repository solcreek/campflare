import { describe, expect, it } from "vitest"
import { Args, decodeCursor, encodeCursor } from "../src/api/args"
import { avatarSvg, initials } from "../src/api/avatar"
import { sign, verify } from "../src/api/crypto"
import { CampflareError } from "../src/api/errors"
import { microsToTs, nextTs, normalizeTs, randomId, tsToMicros } from "../src/api/ids"
import { imageSize, isAnimated, mimeOf } from "../src/api/media"
import { ftsString, indexable, likePattern, parseSearch } from "../src/api/search-query"
import { issueTicket, readTicket } from "../src/api/tickets"
import { formState, givenValues, type Given } from "../src/views"
import { makeGif } from "./images"

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

  it("tells animated GIFs and WebPs by their frames, not their loop extension", () => {
    expect(isAnimated(makeGif(20, 10, 1))).toBe(false)
    expect(isAnimated(makeGif(20, 10, 2))).toBe(true)
    expect(isAnimated(makeGif(20, 10, 3, { comment: true, localTable: true }))).toBe(true)
    // A single frame with NETSCAPE2.0, as some encoders write every GIF, is still.
    expect(isAnimated(makeGif(20, 10, 1, { loop: true, comment: true }))).toBe(false)
    expect(isAnimated(makeGif(20, 10, 2, { loop: false }))).toBe(true)
    // Cut off before the second frame, or not a GIF block: still.
    const one = makeGif(20, 10, 1)
    const two = makeGif(20, 10, 2)
    // Everything up to the end of the first frame: the trailer's byte less, NETSCAPE2.0's 19 more.
    expect(isAnimated(two.subarray(0, one.length - 1 + 19))).toBe(false)
    expect(isAnimated(two.subarray(0, one.length + 19))).toBe(false)
    expect(isAnimated(new Uint8Array([...one.subarray(0, one.length - 1), 0x99]))).toBe(false)
    // WebP: the animation flag of the VP8X header; simple VP8 and VP8L files never move.
    expect(isAnimated(riff("VP8X", [10, 0, 0, 0, 0x02, 0, 0, 0, 9, 0, 0, 4, 0, 0]))).toBe(true)
    expect(isAnimated(riff("VP8X", [10, 0, 0, 0, 0x10, 0, 0, 0, 9, 0, 0, 4, 0, 0]))).toBe(false)
    expect(isAnimated(riff("VP8 ", [0, 0, 0, 0, 0x02, 0, 0, 0, 0, 0, 100, 0, 50, 0]))).toBe(false)
    expect(isAnimated(new TextEncoder().encode("\x89PNG\r\n\x1a\n"))).toBe(false)
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

describe("avatar initials", () => {
  it("takes the first and last word's first letter, or one CJK character", () => {
    expect(initials("Olive Owner")).toBe("OO")
    expect(initials("  émile  ")).toBe("É")
    expect(initials("José María García")).toBe("JG")
    expect(initials("Jürgen Groß")).toBe("JG")
    expect(initials("王小明")).toBe("王")
    expect(initials("山田 太郎")).toBe("山")
    expect(initials("김민준")).toBe("김")
    // A letter with a combining accent stays one letter.
    expect(initials("e\u0301lodie")).toBe("E\u0301")
    expect(initials("")).toBe("")
  })

  it("escapes the initials in the SVG and leaves them out for no name", () => {
    expect(avatarSvg("U1", "<b> &x")).toContain(">&lt;&amp;</text>")
    expect(avatarSvg("U1", "")).not.toContain("<text")
    expect(avatarSvg("U1", "a")).toBe(avatarSvg("U1", "a"))
    expect(avatarSvg("U1", "a")).not.toBe(avatarSvg("U2", "a"))
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

describe("a view's form state", () => {
  const text = (t: string) => ({ type: "plain_text", text: t })
  const option = (t: string, value: string) => ({ text: text(t), value })
  const input = (block_id: string, element: Record<string, unknown>, optional = true) => ({
    type: "input",
    block_id,
    label: text(block_id),
    optional,
    element: { action_id: "a", ...element },
  })
  const view = {
    blocks: [
      input("count", { type: "number_input", is_decimal_allowed: false, initial_value: "3" }),
      input("ratio", { type: "number_input", is_decimal_allowed: true }),
      input("mail", { type: "email_text_input" }, false),
      input("short", { type: "plain_text_input", min_length: 3 }),
      input("tags", {
        type: "multi_static_select",
        option_groups: [{ label: text("g"), options: [option("Uno", "1"), option("Dos", "2")] }],
        initial_options: [option("Uno", "1")],
      }),
      input("people", { type: "multi_users_select", initial_users: ["U1"] }),
      input("rooms", { type: "multi_conversations_select" }),
      input("chans", { type: "multi_channels_select" }),
      input("at", { type: "timepicker", initial_time: "09:30" }),
      input("pick", { type: "conversations_select", initial_conversation: "C1" }),
      input("rich", { type: "rich_text_input" }),
      { type: "section", block_id: "s", text: { type: "mrkdwn", text: "x" } },
    ],
  }

  it("keeps initial values, in Slack's shape, and collects the ids chosen", () => {
    const state = formState(view, { mail: { a: "a@example.com" }, chans: { a: ["C2", "C3"] } })
    expect(state.errors).toEqual({})
    expect(state.values).toEqual({
      count: { a: { type: "number_input", value: "3" } },
      ratio: { a: { type: "number_input", value: null } },
      mail: { a: { type: "email_text_input", value: "a@example.com" } },
      short: { a: { type: "plain_text_input", value: null } },
      tags: { a: { type: "multi_static_select", selected_options: [option("Uno", "1")] } },
      people: { a: { type: "multi_users_select", selected_users: ["U1"] } },
      rooms: { a: { type: "multi_conversations_select", selected_conversations: [] } },
      chans: { a: { type: "multi_channels_select", selected_channels: ["C2", "C3"] } },
      at: { a: { type: "timepicker", selected_time: "09:30" } },
      pick: { a: { type: "conversations_select", selected_conversation: "C1" } },
      rich: { a: { type: "rich_text_input" } },
    })
    expect(state.choices).toEqual([
      { field: "selected_user", id: "U1" },
      { field: "selected_channel", id: "C2" },
      { field: "selected_channel", id: "C3" },
      { field: "selected_conversation", id: "C1" },
    ])
  })

  it("says what's wrong with each input, as Slack's client does", () => {
    const state = formState(view, { count: { a: "2.5" }, ratio: { a: "x" }, short: { a: "ab" } })
    expect(state.errors).toEqual({
      count: "Enter a whole number.",
      ratio: "Enter a number.",
      mail: "Please complete this required field.",
      short: "Use at least 3 characters.",
    })
    expect(formState(view, { ratio: { a: "0.5" }, mail: { a: "m" } }).errors).toEqual({})
    const bad = (given: Given) => {
      try {
        formState(view, given)
      } catch (error) {
        return ((error as CampflareError).extra.response_metadata as { messages: string[] }).messages[0]
      }
    }
    expect(bad({ at: { a: "9am" } })).toBe("[ERROR] at.a must be HH:mm")
    expect(bad({ tags: { a: ["3"] } })).toBe("[ERROR] tags.a has no option 3")
    expect(bad({ rich: { a: "x" } })).toBe("[ERROR] rich.a is a rich_text_input, which can't be filled in yet")
    expect(bad({ s: { a: "x" } })).toBe("[ERROR] no input s.a in this view")
  })

  it("takes values only as strings or lists of strings", () => {
    expect(givenValues(undefined)).toEqual({})
    expect(() => givenValues([])).toThrow(CampflareError)
    expect(() => givenValues({ b: "x" })).toThrow(CampflareError)
    expect(givenValues({ b: { a: ["x"], c: null } })).toEqual({ b: { a: ["x"], c: null } })
  })
})
