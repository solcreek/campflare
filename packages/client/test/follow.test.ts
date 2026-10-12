import { describe, expect, it } from "vitest"
import { createClient, follow, type Fetch, type RealtimeEvent } from "../src/index"

/** A fake server answering campflare.events.poll from a script of pages. */
function server(pages: (Record<string, unknown> | Error)[]) {
  const asked: URLSearchParams[] = []
  const fetch: Fetch = async (_input, init) => {
    asked.push(new URLSearchParams(String(init?.body)))
    const next = pages.shift()
    if (next === undefined) return new Promise<Response>(() => undefined) // hang, like a long poll
    if (next instanceof Error) throw next
    return Response.json(next)
  }
  return { client: createClient({ url: "https://x.test", token: "xoxp-1", fetch }), asked }
}

const page = (cursor: string, events: [string, string][] = []) => ({
  ok: true,
  cursor,
  has_more: false,
  events: events.map(([at, text]) => ({ cursor: at, event: { type: "message", text } })),
})

const tick = () => new Promise((r) => setTimeout(r, 0))
const until = async (check: () => boolean) => {
  for (let i = 0; i < 100 && !check(); i++) await tick()
}

describe("follow", () => {
  it("starts from now, then delivers events in order with their cursors", async () => {
    const { client, asked } = server([
      page("5"),
      page("7", [
        ["6", "a"],
        ["7", "b"],
      ]),
      page("7"),
    ])
    const got: [string, string][] = []
    const cursors: string[] = []
    const f = follow({
      client,
      onEvent: (e: RealtimeEvent, at) => got.push([at, String(e.text)]),
      onCursor: (c) => cursors.push(c),
    })
    await until(() => asked.length >= 4)
    f.close()
    expect(got).toEqual([
      ["6", "a"],
      ["7", "b"],
    ])
    expect(cursors).toEqual(["5", "7", "7"])
    expect(asked[0]!.get("cursor")).toBeNull()
    expect(asked[1]!.get("cursor")).toBe("5")
    expect(asked[1]!.get("wait")).toBe("30")
    expect(asked[2]!.get("cursor")).toBe("7")
  })

  it("resumes from a given cursor", async () => {
    const { client, asked } = server([page("9", [["9", "x"]])])
    const f = follow({ client, cursor: "8", waitSeconds: 5, onEvent: () => undefined })
    await until(() => asked.length >= 2)
    f.close()
    expect(asked[0]!.get("cursor")).toBe("8")
    expect(asked[0]!.get("wait")).toBe("5")
  })

  it("reports a gap and restarts from now when the cursor expired", async () => {
    const { client, asked } = server([{ ok: false, error: "cursor_expired" }, page("50")])
    let gaps = 0
    const f = follow({ client, cursor: "1", onEvent: () => undefined, onGap: () => gaps++ })
    await until(() => asked.length >= 3)
    f.close()
    expect(gaps).toBe(1)
    expect(asked[1]!.get("cursor")).toBeNull()
    expect(asked[2]!.get("cursor")).toBe("50")
  })

  it("backs off after errors, then carries on", async () => {
    const { client, asked } = server([
      new Error("network down"),
      { ok: false, error: "internal_error" },
      page("3", [["3", "ok"]]),
    ])
    const waits: number[] = []
    const errors: unknown[] = []
    const got: string[] = []
    const f = follow({
      client,
      cursor: "2",
      minDelayMs: 10,
      sleep: async (ms) => void waits.push(ms),
      onError: (e) => errors.push(e),
      onEvent: (e) => got.push(String(e.text)),
    })
    await until(() => got.length === 1)
    f.close()
    expect(waits).toEqual([10, 20])
    expect(errors).toHaveLength(2)
    expect(asked.length).toBeGreaterThanOrEqual(3)
  })

  it("stops quietly when closed mid-poll", async () => {
    let release: ((r: Response) => void) | undefined
    const fetch: Fetch = async () => new Promise<Response>((r) => (release = r))
    const got: unknown[] = []
    const f = follow({
      client: createClient({ url: "https://x.test", fetch }),
      cursor: "1",
      onEvent: (e) => got.push(e),
    })
    await tick()
    f.close()
    release?.(Response.json(page("2", [["2", "late"]])))
    await f.done
    expect(got).toEqual([])
  })

  it("stops quietly when closed while a poll fails", async () => {
    let fail: ((e: Error) => void) | undefined
    const fetch: Fetch = async () => new Promise<Response>((_, reject) => (fail = reject))
    const errors: unknown[] = []
    const f = follow({
      client: createClient({ url: "https://x.test", fetch }),
      cursor: "1",
      onEvent: () => undefined,
      onError: (e) => errors.push(e),
    })
    await tick()
    f.close()
    fail?.(new Error("aborted"))
    await f.done
    expect(errors).toEqual([])
  })

  it("uses a real timer by default", async () => {
    const { client } = server([new Error("once"), page("2")])
    const errors: unknown[] = []
    const f = follow({ client, cursor: "1", minDelayMs: 1, onEvent: () => undefined, onError: (e) => errors.push(e) })
    await new Promise((r) => setTimeout(r, 20))
    f.close()
    expect(errors).toHaveLength(1)
  })
})
