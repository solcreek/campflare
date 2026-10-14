import { createClient } from "@campflare/client"
import { createWorkspace, keyOf, sidebar, thread, timeline, type Workspace } from "@campflare/core"
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest"
import { seed, type Seeded } from "../../scripts/seed.ts"

// @campflare/core against the real Worker: two people's workspaces, live over
// RTM, seeing each other's changes as an app's UI would.

const base = inject("baseUrl")
let seeded: Seeded
let alex: Workspace
let vincent: Workspace

/** Waits until the workspace's state passes the check. */
function until(ws: Workspace, check: () => boolean, ms = 5000): Promise<void> {
  if (check()) return Promise.resolve()
  return new Promise((ok, fail) => {
    const timer = setTimeout(() => {
      off()
      fail(new Error("timed out waiting for the workspace"))
    }, ms)
    const off = ws.subscribe(() => {
      if (!check()) return
      clearTimeout(timer)
      off()
      ok()
    })
  })
}

beforeAll(async () => {
  seeded = await seed(base, "conformance", `Core ${Date.now()}`)
  alex = createWorkspace({ client: createClient({ url: base, token: seeded.owner }) })
  vincent = createWorkspace({ client: createClient({ url: base, token: seeded.people.vincent! }) })
  await Promise.all([alex.start(), vincent.start()])
  await Promise.all([
    until(alex, () => alex.getState().connection === "connected"),
    until(vincent, () => vincent.getState().connection === "connected"),
  ])
})

afterAll(() => {
  alex?.stop()
  vincent?.stop()
})

describe("@campflare/core against the server", () => {
  it("loads the seeded workspace", () => {
    const s = alex.getState()
    expect(s.self?.teamName).toMatch(/^Core /)
    const side = sidebar(s)
    expect(side.channels.map((c) => c.name)).toEqual(["dev", "general", "random", "world"])
    expect(side.directMessages).toHaveLength(2)
  })

  it("reads history and threads in every script", async () => {
    await alex.loadHistory(seeded.channels.world!)
    const texts = timeline(alex.getState(), seeded.channels.world!).map((m) => m.text)
    for (const greeting of [
      "좋은 아침입니다",
      "大家早安",
      "皆さん、おはようございます",
      "Buenos días a todos",
      "Bonjour à tous",
      "Guten Morgen zusammen",
    ])
      expect(texts.some((t) => t?.includes(greeting))).toBe(true)

    const dev = seeded.channels.dev!
    await alex.loadHistory(dev)
    const head = timeline(alex.getState(), dev).find((m) => (m.reply_count ?? 0) > 0)!
    await alex.loadReplies(dev, head.ts)
    expect(thread(alex.getState(), dev, head.ts).map((m) => m.text)).toEqual([
      "The deploy to staging failed again, anyone looking?",
      "Looking now: the D1 migration ran twice.",
      "I'll add a guard to the migration script.",
    ])
  })

  it("delivers a message, a reply and a reaction live", async () => {
    const random = seeded.channels.random!
    await Promise.all([alex.loadHistory(random), vincent.loadHistory(random)])
    await alex.send(random, "¿Almorzamos? 一起吃午餐？")
    const sent = timeline(alex.getState(), random).at(-1)!
    expect(sent.pending).toBeUndefined()
    await until(vincent, () => timeline(vincent.getState(), random).some((m) => m.ts === sent.ts))
    expect(vincent.getState().unread[random]).toBe(1)

    await vincent.send(random, "Oui, à midi", { threadTs: sent.ts })
    await until(alex, () => alex.getState().messages[keyOf(random, sent.ts)]?.reply_count === 1)

    await vincent.toggleReaction(random, sent.ts, "raised_hands")
    await until(alex, () => (alex.getState().messages[keyOf(random, sent.ts)]?.reactions?.length ?? 0) === 1)

    await vincent.markRead(random)
    expect(vincent.getState().unread[random]).toBeUndefined()
  })

  it("follows edits, deletes and new channels", async () => {
    const general = seeded.channels.general!
    await Promise.all([alex.loadHistory(general), vincent.loadHistory(general)])
    await alex.send(general, "typo")
    const ts = timeline(alex.getState(), general).at(-1)!.ts
    await until(vincent, () => Boolean(vincent.getState().messages[keyOf(general, ts)]))
    await alex.edit(general, ts, "fixed")
    await until(vincent, () => vincent.getState().messages[keyOf(general, ts)]?.text === "fixed")
    await alex.remove(general, ts)
    await until(vincent, () => !vincent.getState().messages[keyOf(general, ts)])

    const id = await alex.createChannel(`core-${Date.now()}`)
    await until(vincent, () => Boolean(vincent.getState().conversations[id]))
    expect(vincent.getState().conversations[id]?.is_member).toBe(false)
    await vincent.join(id)
    expect(sidebar(vincent.getState()).channels.some((c) => c.id === id)).toBe(true)
  })

  it("opens a DM that the other side learns about from the first message", async () => {
    const minjun = createWorkspace({ client: createClient({ url: base, token: seeded.people.minjun! }) })
    await minjun.start()
    await until(minjun, () => minjun.getState().connection === "connected")
    const minjunId = minjun.getState().self!.userId
    const dm = await alex.openDm([minjunId])
    await alex.send(dm, "안녕하세요")
    await until(minjun, () => Boolean(minjun.getState().conversations[dm]))
    expect(minjun.getState().unread[dm]).toBe(1)
    minjun.stop()
  })

  it("shows an app's thread status to someone who connects after it was set, and stops its stream", async () => {
    const bot = createClient({ url: base, token: seeded.botToken })
    const general = seeded.channels.general!
    const owner = createClient({ url: base, token: seeded.owner })
    const { ts: question } = await owner.call<{ ok: boolean; ts: string }>("chat.postMessage", {
      channel: general,
      text: "¿Qué hora es?",
    })
    await bot.call("assistant.threads.setStatus", { channel_id: general, thread_ts: question, status: "is checking" })
    const { ts } = await bot.call<{ ok: boolean; ts: string }>("chat.startStream", {
      channel: general,
      thread_ts: question,
      markdown_text: "Il est",
      recipient_user_id: alex.getState().self!.userId,
      recipient_team_id: seeded.teamId,
    })
    // The reply ended the status; a new one comes after it.
    await bot.call("assistant.threads.setStatus", { channel_id: general, thread_ts: question, status: "is counting" })

    const late = createWorkspace({ client: createClient({ url: base, token: seeded.people.vincent! }) })
    await late.start()
    const key = keyOf(general, question)
    await until(late, () => late.getState().statuses[key]?.status === "is counting")

    await late.stopStream(general, ts)
    await until(alex, () => alex.getState().messages[keyOf(general, ts)]?.streaming_state === "completed")
    await expect(bot.call("chat.appendStream", { channel: general, ts, markdown_text: " midi" })).rejects.toThrow(
      "stopped_by_user",
    )
    late.stop()
  })
})
