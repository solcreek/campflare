import { runInDurableObject } from "cloudflare:test"
import { env } from "cloudflare:workers"
import { describe, expect, it } from "vitest"
import { EVENT_RETENTION_MS, type TeamHub } from "../src/hub"
import { call, expectError, ok, workspace } from "./helpers"

type Poll = { events: { cursor: string; event: Record<string, unknown> }[]; cursor: string; has_more: boolean }

const poll = (token: string, args: Record<string, unknown> = {}) => ok<Poll>("campflare.events.poll", args, token)

describe("campflare.events.poll", () => {
  it("starts from now, then returns what came since, in order", async () => {
    const w = await workspace()
    const start = await poll(w.owner.token)
    expect(start.events).toEqual([])
    const a = await ok<{ ts: string }>("chat.postMessage", { channel: w.general, text: "one" }, w.owner.token)
    await ok("reactions.add", { channel: w.general, timestamp: a.ts, name: "eyes" }, w.owner.token)
    // Events land after the response; wait for them.
    const page = await poll(w.owner.token, { cursor: start.cursor, wait: 2 })
    const types = page.events.map((e) => e.event.type)
    expect(types[0]).toBe("message")
    expect(page.events[0]!.event).toMatchObject({ text: "one", channel: w.general, ts: a.ts })
    // Numbered in order, and the next cursor continues after them.
    const cursors = page.events.map((e) => Number(e.cursor))
    expect(cursors).toEqual(cursors.toSorted((x, y) => x - y))
    let rest = await poll(w.owner.token, { cursor: page.cursor, wait: 2 })
    const all = [...types, ...rest.events.map((e) => e.event.type)]
    expect(all).toContain("reaction_added")
    rest = await poll(w.owner.token, { cursor: rest.cursor })
    expect(rest.events).toEqual([])
  })

  it("long-polls until an event arrives", async () => {
    const w = await workspace()
    const { cursor } = await poll(w.owner.token)
    const started = Date.now()
    const waiting = poll(w.owner.token, { cursor, wait: 10 })
    await new Promise((r) => setTimeout(r, 100))
    await ok("chat.postMessage", { channel: w.general, text: "wake up" }, w.owner.token)
    const page = await waiting
    expect(page.events.map((e) => e.event.text)).toContain("wake up")
    expect(Date.now() - started).toBeLessThan(5000)
  })

  it("times out empty, and returns at once without wait", async () => {
    const w = await workspace()
    const { cursor } = await poll(w.owner.token)
    const started = Date.now()
    expect((await poll(w.owner.token, { cursor, wait: 1 })).events).toEqual([])
    expect(Date.now() - started).toBeGreaterThanOrEqual(900)
    expect((await poll(w.owner.token, { cursor })).events).toEqual([])
  })

  it("only shows what the user can see, but moves the cursor past the rest", async () => {
    const w = await workspace()
    const bob = await w.addUser("bob")
    const { cursor } = await poll(bob.token)
    const { channel } = await ok<{ channel: { id: string } }>(
      "conversations.create",
      { name: "x", is_private: true },
      w.owner.token,
    )
    await ok("chat.postMessage", { channel: channel.id, text: "secret" }, w.owner.token)
    await ok("conversations.mark", { channel: w.general, ts: "1.000000" }, w.owner.token) // owner's own marker
    await ok("chat.postMessage", { channel: w.general, text: "public" }, w.owner.token)
    let seen: string[] = []
    let next = cursor
    for (let i = 0; i < 5 && !seen.includes("public"); i++) {
      const page = await poll(bob.token, { cursor: next, wait: 1 })
      seen = [...seen, ...page.events.map((e) => String(e.event.text ?? e.event.type))]
      next = page.cursor
    }
    expect(seen).toContain("public")
    expect(seen).not.toContain("secret")
    expect(seen).not.toContain("channel_marked")
    expect(Number(next)).toBeGreaterThan(Number(cursor))
  })

  it("pages with limit and has_more", async () => {
    const w = await workspace()
    const { cursor } = await poll(w.owner.token)
    for (let i = 0; i < 3; i++) await ok("chat.postMessage", { channel: w.general, text: `m${i}` }, w.owner.token)
    let page = await poll(w.owner.token, { cursor, limit: 2, wait: 2 })
    for (let i = 0; i < 20 && page.events.length < 2; i++)
      page = await poll(w.owner.token, { cursor, limit: 2, wait: 1 })
    expect(page.events.map((e) => e.event.text)).toEqual(["m0", "m1"])
    expect(page.has_more).toBe(true)
    expect(page.cursor).toBe(page.events[1]!.cursor)
    const rest = await poll(w.owner.token, { cursor: page.cursor, wait: 2 })
    expect(rest.events.map((e) => e.event.text)).toEqual(["m2"])
  })

  it("works with a bot token, as the bot user", async () => {
    const w = await workspace()
    const app = await w.addApp("Robot")
    const { cursor } = await poll(app.botToken)
    await ok("chat.postMessage", { channel: w.general, text: "hi bot" }, w.owner.token)
    let texts: unknown[] = []
    let next = cursor
    for (let i = 0; i < 5 && !texts.includes("hi bot"); i++) {
      const page = await poll(app.botToken, { cursor: next, wait: 1 })
      texts = [...texts, ...page.events.map((e) => e.event.text)]
      next = page.cursor
    }
    expect(texts).toContain("hi bot")
    await expectError("campflare.events.poll", {}, app.appToken, "not_allowed_token_type")
  })

  it("rejects bad cursors and says when events were dropped", async () => {
    const w = await workspace()
    await expectError("campflare.events.poll", { cursor: "abc" }, w.owner.token, "invalid_cursor")
    await expectError("campflare.events.poll", { cursor: "999999" }, w.owner.token, "invalid_cursor")
    const { cursor } = await poll(w.owner.token)
    await ok("chat.postMessage", { channel: w.general, text: "old" }, w.owner.token)
    await poll(w.owner.token, { cursor, wait: 2 })
    // Age every event past the retention window, then let a 100th insert prune them.
    const stub = env.HUB.get(env.HUB.idFromName(w.teamId))
    await runInDurableObject(stub, async (_hub: TeamHub, state) => {
      state.storage.sql.exec("UPDATE events SET at = ?", Date.now() - EVENT_RETENTION_MS - 1)
      state.storage.sql.exec("UPDATE sqlite_sequence SET seq = 99 WHERE name = 'events'")
    })
    await ok("chat.postMessage", { channel: w.general, text: "new" }, w.owner.token)
    let body = await call("campflare.events.poll", { cursor }, w.owner.token)
    for (let i = 0; i < 20 && body.error !== "cursor_expired"; i++) {
      await new Promise((r) => setTimeout(r, 25))
      body = await call("campflare.events.poll", { cursor }, w.owner.token)
    }
    expect(body).toMatchObject({ ok: false, error: "cursor_expired" })
    // Starting again from now works.
    expect((await poll(w.owner.token)).cursor).toBe("100")
  })
})
