import { describe, expect, it } from "vitest"
import { type Action, initialState, keyOf, reduce, type WorkspaceState } from "../src/state"
import type { Message } from "../src/types"

const self = { url: "https://x.test", userId: "U1", teamId: "T1", teamName: "Team" }

function run(...actions: Action[]): WorkspaceState {
  return actions.reduce(reduce, initialState)
}

const ready: Action = {
  type: "ready",
  self,
  users: [{ id: "U1", name: "alex" }],
  conversations: [{ id: "C1", name: "general", is_channel: true, is_member: true, last_read: "0000000100.000000" }],
}

const msg = (ts: string, extra: Partial<Message> = {}): Message => ({
  ts,
  channel: "C1",
  user: "U2",
  text: ts,
  ...extra,
})
const history = (messages: Message[], extra: Partial<Extract<Action, { type: "history" }>> = {}): Action => ({
  type: "history",
  channel: "C1",
  messages,
  hasMore: false,
  older: false,
  ...extra,
})
const event = (e: Record<string, unknown>): Action => ({ type: "event", event: { type: "message", ...e } })
const r = (type: string, user: string, reaction = "eyes"): Action => ({
  type: "event",
  event: { type, user, reaction, item: { type: "message", channel: "C1", ts: "0000000200.000000" } },
})
const e = (raw: Record<string, unknown>): Action => ({ type: "event", event: raw as { type: string } })
const tsList = (s: WorkspaceState, channel = "C1") => (s.timelines[channel]?.keys ?? []).map((k) => s.messages[k]!.ts)

describe("reduce", () => {
  it("moves through loading, failure and ready", () => {
    expect(run({ type: "loading" }).status).toBe("loading")
    expect(run({ type: "failed", error: "invalid_auth" })).toMatchObject({ status: "error", error: "invalid_auth" })
    const s = run({ type: "failed", error: "x" }, ready)
    expect(s).toMatchObject({ status: "ready", error: undefined, self })
    expect(s.users.U1?.name).toBe("alex")
    expect(run({ type: "connection", status: "connected" }).connection).toBe("connected")
  })

  it("merges users and conversations", () => {
    const s = run(
      ready,
      { type: "users", users: [{ id: "U2", name: "vincent" }] },
      { type: "conversation", conversation: { id: "C1", topic: { value: "hi" } } },
    )
    expect(s.users.U2?.name).toBe("vincent")
    expect(s.conversations.C1).toMatchObject({ name: "general", topic: { value: "hi" } })
  })

  it("orders history oldest first and pages older messages in", () => {
    let s = run(ready, history([msg("0000000300.000000"), msg("0000000200.000000")], { hasMore: true }))
    expect(tsList(s)).toEqual(["0000000200.000000", "0000000300.000000"])
    expect(s.timelines.C1?.hasMore).toBe(true)
    s = reduce(s, history([msg("0000000150.000000")], { older: true, hasMore: false }))
    expect(tsList(s)).toEqual(["0000000150.000000", "0000000200.000000", "0000000300.000000"])
    expect(s.timelines.C1?.hasMore).toBe(false)
    expect(s.messages[keyOf("C1", "0000000150.000000")]?.channel).toBe("C1")
  })

  it("treats a fresh latest page as the truth for its range", () => {
    let s = run(ready, history([msg("0000000300.000000"), msg("0000000200.000000"), msg("0000000100.000000")]))
    s = reduce(s, { type: "sending", message: msg("~00000001", { pending: true, user: "U1" }) })
    // 300 was deleted while we were away; 400 is new; 100 is older than the page and stays.
    s = reduce(s, history([msg("0000000400.000000"), msg("0000000200.000000")], { hasMore: true }))
    expect(tsList(s)).toEqual(["0000000100.000000", "0000000200.000000", "0000000400.000000", "~00000001"])
    expect(s.messages[keyOf("C1", "0000000300.000000")]).toBeUndefined()
    // A refresh keeps what it knew about older pages.
    expect(s.timelines.C1?.hasMore).toBe(false)
    // An empty latest page changes nothing.
    expect(tsList(reduce(s, history([])))).toEqual(tsList(s))
  })

  it("keeps a thread's replies apart from the channel", () => {
    let s = run(ready, history([msg("0000000200.000000", { thread_ts: "0000000200.000000", reply_count: 1 })]))
    s = reduce(s, {
      type: "replies",
      channel: "C1",
      threadTs: "0000000200.000000",
      messages: [
        msg("0000000200.000000", { thread_ts: "0000000200.000000", reply_count: 1 }),
        msg("0000000250.000000", { thread_ts: "0000000200.000000" }),
      ],
    })
    const threadKey = keyOf("C1", "0000000200.000000")
    expect(s.threads[threadKey]?.keys).toEqual([keyOf("C1", "0000000250.000000")])
    expect(tsList(s)).toEqual(["0000000200.000000"])

    // A live reply lands in the thread and counts on the parent.
    s = reduce(s, event({ channel: "C1", ts: "0000000260.000000", thread_ts: "0000000200.000000", user: "U3" }))
    expect(s.threads[threadKey]?.keys).toHaveLength(2)
    expect(s.messages[threadKey]).toMatchObject({
      reply_count: 2,
      latest_reply: "0000000260.000000",
      reply_users: ["U3"],
    })
    // The same reply again (RTM after the HTTP answer) counts once.
    s = reduce(s, event({ channel: "C1", ts: "0000000260.000000", thread_ts: "0000000200.000000", user: "U3" }))
    expect(s.messages[threadKey]?.reply_count).toBe(2)
    // A second reply from the same person doesn't list them twice.
    s = reduce(s, event({ channel: "C1", ts: "0000000270.000000", thread_ts: "0000000200.000000", user: "U3" }))
    expect(s.messages[threadKey]?.reply_users).toEqual(["U3"])

    // Deleting a reply takes it out and uncounts it.
    s = reduce(s, event({ channel: "C1", subtype: "message_deleted", deleted_ts: "0000000260.000000" }))
    expect(s.threads[threadKey]?.keys).toHaveLength(2)
    expect(s.messages[threadKey]?.reply_count).toBe(2)

    // A broadcast reply shows in the channel too.
    s = reduce(
      s,
      event({ channel: "C1", ts: "0000000280.000000", thread_ts: "0000000200.000000", subtype: "thread_broadcast" }),
    )
    expect(tsList(s)).toContain("0000000280.000000")
  })

  it("files a reply whose thread was never opened, and deletes one never loaded", () => {
    let s = run(ready, event({ channel: "C1", ts: "0000000260.000000", thread_ts: "0000000200.000000" }))
    expect(s.threads[keyOf("C1", "0000000200.000000")]?.keys).toEqual([keyOf("C1", "0000000260.000000")])
    const before = s
    s = reduce(s, event({ channel: "C1", subtype: "message_deleted", deleted_ts: "0000000999.000000" }))
    expect(s).toBe(before)
    // Deleting a reply whose thread list isn't loaded only drops the message.
    s = run(ready, { type: "sending", message: msg("~1", { thread_ts: "0000000200.000000", pending: true }) })
    s = { ...s, threads: {} }
    s = reduce(s, { type: "discard", channel: "C1", localTs: "~1" })
    expect(s.messages[keyOf("C1", "~1")]).toBeUndefined()
    // Same for a top-level message without a timeline.
    s = { ...run(ready, event({ channel: "C1", ts: "0000000300.000000" })), timelines: {} }
    s = reduce(s, event({ channel: "C1", subtype: "message_deleted", deleted_ts: "0000000300.000000" }))
    expect(s.messages[keyOf("C1", "0000000300.000000")]).toBeUndefined()
  })

  it("swaps a pending message for the stored one, or marks it failed", () => {
    let s = run(ready, { type: "sending", message: msg("~00000001", { pending: true, user: "U1" }) })
    expect(tsList(s)).toEqual(["~00000001"])
    s = reduce(s, {
      type: "sent",
      channel: "C1",
      localTs: "~00000001",
      message: msg("0000000500.000000", { user: "U1" }),
    })
    expect(tsList(s)).toEqual(["0000000500.000000"])
    s = reduce(s, { type: "sending", message: msg("~00000002", { pending: true, user: "U1" }) })
    s = reduce(s, { type: "sendFailed", channel: "C1", localTs: "~00000002", error: "is_archived" })
    expect(s.messages[keyOf("C1", "~00000002")]?.failed).toBe("is_archived")
    // Unknown local messages are ignored.
    expect(reduce(s, { type: "sendFailed", channel: "C1", localTs: "~9", error: "x" })).toBe(s)
    expect(reduce(s, { type: "discard", channel: "C1", localTs: "~9" })).toBe(s)
    s = reduce(s, { type: "discard", channel: "C1", localTs: "~00000002" })
    expect(tsList(s)).toEqual(["0000000500.000000"])
  })

  it("applies edits only to messages it has", () => {
    let s = run(ready, history([msg("0000000200.000000")]))
    s = reduce(
      s,
      event({ channel: "C1", subtype: "message_changed", message: { ts: "0000000200.000000", text: "fixed" } }),
    )
    expect(s.messages[keyOf("C1", "0000000200.000000")]?.text).toBe("fixed")
    const before = s
    s = reduce(s, event({ channel: "C1", subtype: "message_changed", message: { ts: "0000000001.000000", text: "x" } }))
    expect(s).toBe(before)
  })

  it("counts live messages from others as unread until read", () => {
    let s = run(ready, event({ channel: "C1", ts: "0000000200.000000", user: "U2" }))
    expect(s.unread.C1).toBe(1)
    // Yours, ephemeral, replies and already-read ones don't count.
    s = reduce(s, event({ channel: "C1", ts: "0000000210.000000", user: "U1" }))
    s = reduce(
      s,
      event({ channel: "C1", ts: "0000000220.000000", user: "U2", subtype: "ephemeral", is_ephemeral: true }),
    )
    s = reduce(s, event({ channel: "C1", ts: "0000000230.000000", user: "U2", thread_ts: "0000000200.000000" }))
    s = reduce(s, event({ channel: "C1", ts: "0000000050.000000", user: "U2" }))
    expect(s.unread.C1).toBe(1)
    s = reduce(s, { type: "event", event: { type: "channel_marked", channel: "C1", ts: "0000000230.000000" } })
    expect(s.unread.C1).toBeUndefined()
    expect(s.conversations.C1?.last_read).toBe("0000000230.000000")
    // Marking a conversation the store doesn't know only clears its count.
    s = run(ready, event({ channel: "D9", ts: "0000000200.000000" }))
    s = reduce(s, { type: "read", channel: "D9", ts: "0000000200.000000" })
    expect(s.unread.D9).toBeUndefined()
    expect(s.conversations.D9).toBeUndefined()
  })

  it("adds and removes reactions once per person", () => {
    let s = run(ready, history([msg("0000000200.000000")]), r("reaction_added", "U1"), r("reaction_added", "U2"))
    const key = keyOf("C1", "0000000200.000000")
    expect(s.messages[key]?.reactions).toEqual([{ name: "eyes", users: ["U1", "U2"], count: 2 }])
    expect(reduce(s, r("reaction_added", "U1"))).toBe(s)
    s = reduce(s, r("reaction_removed", "U1"))
    expect(s.messages[key]?.reactions).toEqual([{ name: "eyes", users: ["U2"], count: 1 }])
    s = reduce(s, r("reaction_removed", "U2"))
    expect(s.messages[key]?.reactions).toEqual([])
    expect(reduce(s, r("reaction_removed", "U2"))).toBe(s)
    // Reactions to messages the store doesn't hold are ignored.
    expect(reduce(s, { type: "event", event: { type: "reaction_added", user: "U1", reaction: "x" } })).toBe(s)
  })

  it("follows conversation changes", () => {
    let s = run(
      ready,
      e({ type: "channel_created", channel: { id: "C2", name: "dev", creator: "U1", is_channel: true } }),
      e({ type: "channel_created", channel: { id: "C3", name: "ops", creator: "U2", is_channel: true } }),
    )
    expect(s.conversations.C2?.is_member).toBe(true)
    expect(s.conversations.C3?.is_member).toBe(false)
    expect(reduce(s, e({ type: "channel_created", channel: { id: "C2", name: "x" } }))).toBe(s)
    s = reduce(s, e({ type: "channel_rename", channel: { id: "C2", name: "development" } }))
    expect(s.conversations.C2?.name).toBe("development")
    s = reduce(s, e({ type: "channel_archive", channel: "C2" }))
    expect(s.conversations.C2?.is_archived).toBe(true)
    s = reduce(s, e({ type: "channel_unarchive", channel: "C2" }))
    expect(s.conversations.C2?.is_archived).toBe(false)
    // Unknown conversations and events change nothing.
    expect(reduce(s, e({ type: "channel_archive", channel: "C9" }))).toBe(s)
    expect(reduce(s, e({ type: "hello" }))).toBe(s)
  })

  it("reads membership, topic and purpose from channel messages", () => {
    let s = run(
      ready,
      { type: "conversation", conversation: { id: "C3", name: "ops", is_channel: true, is_member: false } },
      event({ channel: "C3", ts: "0000000300.000000", user: "U1", subtype: "channel_join" }),
    )
    expect(s.conversations.C3?.is_member).toBe(true)
    s = reduce(
      s,
      event({ channel: "C3", ts: "0000000310.000000", user: "U2", subtype: "channel_topic", topic: "Deploys" }),
    )
    s = reduce(
      s,
      event({ channel: "C3", ts: "0000000320.000000", user: "U2", subtype: "channel_purpose", purpose: "Ops" }),
    )
    expect(s.conversations.C3).toMatchObject({ topic: { value: "Deploys" }, purpose: { value: "Ops" } })
    // Someone else joining or leaving doesn't change yours.
    s = reduce(s, event({ channel: "C3", ts: "0000000330.000000", user: "U2", subtype: "channel_leave" }))
    expect(s.conversations.C3?.is_member).toBe(true)
    s = reduce(s, event({ channel: "C3", ts: "0000000340.000000", user: "U1", subtype: "channel_leave" }))
    expect(s.conversations.C3?.is_member).toBe(false)
  })
})
