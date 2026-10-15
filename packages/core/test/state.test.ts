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
const uploaded = (ts: string, ...fileIds: string[]): Action => ({
  type: "uploaded",
  channel: "C1",
  localTs: ts,
  fileIds,
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

  it("lets RTM's copy of a sent message replace the pending one before the HTTP answer", () => {
    const pending = (ts: string, id: string, extra: Partial<Message> = {}) =>
      ({ type: "sending", message: msg(ts, { pending: true, user: "U1", client_msg_id: id, ...extra }) }) as Action
    let s = run(ready, pending("~00000001", "a"), pending("~00000002", "b"))
    s = reduce(s, event({ channel: "C1", ts: "0000000500.000000", user: "U1", client_msg_id: "a" }))
    expect(tsList(s)).toEqual(["0000000500.000000", "~00000002"])
    // Then the HTTP answer: nothing left to swap, and no second copy.
    s = reduce(s, {
      type: "sent",
      channel: "C1",
      localTs: "~00000001",
      message: msg("0000000500.000000", { user: "U1" }),
    })
    expect(tsList(s)).toEqual(["0000000500.000000", "~00000002"])

    // In a thread too, counted once on the parent.
    s = run(ready, history([msg("0000000200.000000", { thread_ts: "0000000200.000000", reply_count: 0 })]))
    s = reduce(s, pending("~00000003", "c", { thread_ts: "0000000200.000000" }))
    s = reduce(
      s,
      event({ channel: "C1", ts: "0000000600.000000", user: "U1", thread_ts: "0000000200.000000", client_msg_id: "c" }),
    )
    const threadKey = keyOf("C1", "0000000200.000000")
    expect(s.threads[threadKey]?.keys).toEqual([keyOf("C1", "0000000600.000000")])
    expect(s.messages[threadKey]?.reply_count).toBe(1)
    // A stored message whose id matches nothing pending is just added.
    s = reduce(s, event({ channel: "C1", ts: "0000000700.000000", user: "U2", client_msg_id: "zzz" }))
    expect(tsList(s)).toContain("0000000700.000000")
  })

  it("lets RTM's copy of an upload replace the pending one by its file ids", () => {
    const pending = (ts: string, name: string, extra: Partial<Message> = {}) =>
      ({
        type: "sending",
        message: msg(ts, { pending: true, user: "U1", text: "", files: [{ id: `${ts}-0`, name }], ...extra }),
      }) as Action
    let s = run(ready, pending("~00000001", "東京.png"), pending("~00000002", "résumé.pdf"))
    // Before its bytes are stored, a pending upload has no ids to match.
    s = reduce(s, event({ channel: "C1", ts: "0000000400.000000", user: "U1", files: [{ id: "F9" }] }))
    expect(tsList(s)).toEqual(["0000000400.000000", "~00000001", "~00000002"])
    s = reduce(s, uploaded("~00000001", "F1", "F2"))
    expect(s.messages[keyOf("C1", "~00000001")]?.uploaded).toEqual(["F1", "F2"])
    expect(reduce(s, uploaded("~9", "F3"))).toBe(s)
    s = reduce(s, event({ channel: "C1", ts: "0000000500.000000", user: "U1", files: [{ id: "F2" }, { id: "F1" }] }))
    expect(tsList(s)).toEqual(["0000000400.000000", "0000000500.000000", "~00000002"])
    // Then the workspace drops the pending copy it no longer has.
    expect(reduce(s, { type: "discard", channel: "C1", localTs: "~00000001" })).toBe(s)

    // In a thread too, counted once on the parent.
    const head = "0000000200.000000"
    s = run(ready, history([msg(head, { thread_ts: head, reply_count: 0 })]))
    s = reduce(s, pending("~00000003", "서울.jpg", { thread_ts: head }))
    s = reduce(s, uploaded("~00000003", "F4"))
    s = reduce(s, event({ channel: "C1", ts: "0000000600.000000", user: "U1", thread_ts: head, files: [{ id: "F4" }] }))
    const threadKey = keyOf("C1", head)
    expect(s.threads[threadKey]?.keys).toEqual([keyOf("C1", "0000000600.000000")])
    expect(s.messages[threadKey]?.reply_count).toBe(1)
    expect(s.messages[keyOf("C1", "~00000003")]).toBeUndefined()
  })

  it("drops a pending message when a loaded page holds its stored copy", () => {
    const head = "0000000200.000000"
    let s = run(
      ready,
      history([msg(head, { thread_ts: head })]),
      { type: "sending", message: msg("~00000001", { pending: true, user: "U1", files: [{ id: "~00000001-0" }] }) },
      uploaded("~00000001", "F1"),
      { type: "sending", message: msg("~00000002", { pending: true, user: "U1", client_msg_id: "b" }) },
    )
    const stored = msg("0000000500.000000", { user: "U1", files: [{ id: "F1" }] })
    // An older page too: the pending copy goes, the other pending message stays.
    s = reduce(s, history([stored], { older: true }))
    expect(tsList(s)).toEqual([head, "0000000500.000000", "~00000002"])
    expect(s.messages[keyOf("C1", "~00000001")]).toBeUndefined()
    s = reduce(s, history([msg("0000000600.000000", { user: "U1", client_msg_id: "b" }), stored, msg(head)]))
    expect(tsList(s)).toEqual([head, "0000000500.000000", "0000000600.000000"])

    s = reduce(s, {
      type: "sending",
      message: msg("~00000003", { pending: true, user: "U1", thread_ts: head, client_msg_id: "c" }),
    })
    s = reduce(s, {
      type: "sending",
      message: msg("~00000004", { pending: true, user: "U1", thread_ts: head, client_msg_id: "d" }),
    })
    s = reduce(s, {
      type: "replies",
      channel: "C1",
      threadTs: head,
      messages: [
        msg(head, { thread_ts: head, reply_count: 1 }),
        msg("0000000700.000000", { user: "U1", thread_ts: head, client_msg_id: "c" }),
      ],
    })
    const threadKey = keyOf("C1", head)
    expect(s.threads[threadKey]?.keys).toEqual([keyOf("C1", "0000000700.000000"), keyOf("C1", "~00000004")])
    expect(s.messages[keyOf("C1", "~00000003")]).toBeUndefined()
    expect(s.messages[threadKey]?.reply_count).toBe(1)
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

  it("drops the blocks and attachments an edit leaves out, and keeps the rest", () => {
    const blocks = [{ type: "actions", block_id: "b", elements: [] }]
    let s = run(ready, history([{ ...msg("0000000200.000000"), blocks, attachments: [{ text: "a" }], reply_count: 2 }]))
    s = reduce(
      s,
      event({ channel: "C1", subtype: "message_changed", message: { ts: "0000000200.000000", text: "Approved" } }),
    )
    const edited = s.messages[keyOf("C1", "0000000200.000000")]!
    expect(edited).toMatchObject({ text: "Approved", reply_count: 2 })
    expect(edited.blocks).toBeUndefined()
    expect(edited.attachments).toBeUndefined()
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

  it("keeps a conversation's pins, and the messages' pinned_to, from pins.list and pin events", () => {
    const ts = "0000000200.000000"
    const item = (t: string, created: number) => ({
      channel: "C1",
      created,
      created_by: "U2",
      message: { ts: t, user: "U2", text: "Décision · 決定 · 결정" } as Message,
    })
    let s = run(ready, history([msg(ts), msg("0000000300.000000")]))
    // Before pins.list, an event still marks the loaded message but builds no list.
    s = reduce(s, e({ type: "pin_added", channel_id: "C1", item: item(ts, 10) }))
    expect(s.messages[keyOf("C1", ts)]?.pinned_to).toEqual(["C1"])
    expect(s.pins.C1).toBeUndefined()
    s = reduce(s, { type: "pins", channel: "C1", items: [item(ts, 10)] })
    expect(s.pins.C1).toEqual([
      { ts, created: 10, createdBy: "U2", message: { ts, user: "U2", text: "Décision · 決定 · 결정", channel: "C1" } },
    ])
    s = reduce(s, e({ type: "pin_added", channel_id: "C1", item: item("0000000300.000000", 20) }))
    expect(s.pins.C1?.map((p) => p.ts)).toEqual(["0000000300.000000", ts])
    s = reduce(s, e({ type: "pin_removed", channel_id: "C1", item: item(ts, 10) }))
    expect(s.pins.C1?.map((p) => p.ts)).toEqual(["0000000300.000000"])
    expect(s.messages[keyOf("C1", ts)]).not.toHaveProperty("pinned_to")
    // A deleted message leaves the pins.
    s = reduce(s, event({ channel: "C1", subtype: "message_deleted", deleted_ts: "0000000300.000000" }))
    expect(s.pins.C1).toEqual([])
    expect(reduce(s, e({ type: "pin_added", channel_id: "C1" }))).toBe(s)
    // A pin of a message the store doesn't hold leaves the messages alone.
    const unseen = reduce(s, e({ type: "pin_added", channel_id: "C1", item: item("0000000900.000000", 30) }))
    expect(unseen.messages).toBe(s.messages)
    expect(unseen.pins.C1?.map((p) => p.ts)).toEqual(["0000000900.000000"])
  })

  it("takes pinned_to and is_starred from the server's copies", () => {
    const ts = "0000000200.000000"
    const key = keyOf("C1", ts)
    let s = run(ready, history([msg(ts, { pinned_to: ["C1"], is_starred: true })]))
    // An edit's message_changed carries pinned_to when pinned: without it, the message was unpinned.
    s = reduce(s, event({ channel: "C1", subtype: "message_changed", message: { ts, user: "U2", text: "editado" } }))
    expect(s.messages[key]).not.toHaveProperty("pinned_to")
    // is_starred is the caller's, which events never carry: it stays.
    expect(s.messages[key]?.is_starred).toBe(true)
    const changed = { ts, user: "U2", text: "編集", pinned_to: ["C1"] }
    s = reduce(s, event({ channel: "C1", subtype: "message_changed", message: changed }))
    expect(s.messages[key]?.pinned_to).toEqual(["C1"])
    // A reloaded page is the whole truth for both.
    s = reduce(s, history([msg(ts)]))
    expect(s.messages[key]).not.toHaveProperty("pinned_to")
    expect(s.messages[key]).not.toHaveProperty("is_starred")
  })

  it("keeps a conversation's bookmarks bar in rank order", () => {
    const bm = (id: string, rank: string, title = id) => ({
      id,
      channel_id: "C1",
      title,
      link: `https://example.com/${id}`,
      rank,
    })
    let s = run(ready)
    expect(reduce(s, e({ type: "bookmark_added", channel_id: "C1", bookmark: bm("Bk1", "1") }))).toBe(s)
    s = reduce(s, { type: "bookmarks", channel: "C1", bookmarks: [bm("Bk2", "0000000002"), bm("Bk1", "0000000001")] })
    expect(s.bookmarks.C1?.map((b) => b.id)).toEqual(["Bk1", "Bk2"])
    s = reduce(s, e({ type: "bookmark_added", channel_id: "C1", bookmark: bm("Bk3", "0000000003", "Ñandú") }))
    s = reduce(s, e({ type: "bookmark_changed", bookmark: bm("Bk1", "0000000001", "手册") }))
    expect(s.bookmarks.C1?.map((b) => b.title)).toEqual(["手册", "Bk2", "Ñandú"])
    s = reduce(s, e({ type: "bookmark_removed", channel_id: "C1", bookmark: bm("Bk2", "0000000002") }))
    expect(s.bookmarks.C1?.map((b) => b.id)).toEqual(["Bk1", "Bk3"])
    expect(reduce(s, e({ type: "bookmark_removed", channel_id: "C1" }))).toBe(s)
  })

  it("marks saved messages is_starred from star events", () => {
    const ts = "0000000200.000000"
    const star = (type: string, item: Record<string, unknown>) => e({ type, user: "U1", item })
    let s = run(ready, history([msg(ts)]))
    s = reduce(s, star("star_added", { type: "message", channel: "C1", message: { ts } }))
    expect(s.messages[keyOf("C1", ts)]?.is_starred).toBe(true)
    s = reduce(s, star("star_removed", { type: "message", channel: "C1", message: { ts } }))
    expect(s.messages[keyOf("C1", ts)]).not.toHaveProperty("is_starred")
    expect(reduce(s, star("star_added", { type: "channel", channel: "C1" }))).toBe(s)
    expect(reduce(s, star("star_added", { type: "message", channel: "C1", message: { ts: "1.000000" } }))).toBe(s)
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

describe("streamed messages and thread statuses", () => {
  const head = "0000000100.000000"
  const threadKey = keyOf("C1", head)
  const status = (s: string | undefined, extra: Record<string, unknown> = {}) =>
    e({
      type: "assistant_thread_status_changed",
      channel: "C1",
      thread_ts: head,
      status: s,
      user: "UBOT",
      event_ts: "0000000150.000000",
      ...extra,
    })
  const loaded = () =>
    run(ready, history([msg(head, { thread_ts: head, reply_count: 0 })]), {
      type: "replies",
      channel: "C1",
      threadTs: head,
      messages: [msg(head, { thread_ts: head })],
    })

  it("grows a streamed reply in place, from message to message_changed", () => {
    const reply = { ts: "0000000160.000000", thread_ts: head, user: "UBOT", streaming_state: "in_progress" }
    let s = reduce(
      loaded(),
      event({ channel: "C1", ...reply, text: "Hel", blocks: [{ type: "markdown", text: "Hel" }] }),
    )
    const key = keyOf("C1", reply.ts)
    expect(s.threads[threadKey]?.keys).toEqual([key])
    expect(s.messages[threadKey]?.reply_count).toBe(1)
    s = reduce(s, event({ channel: "C1", subtype: "message_changed", message: { ...reply, text: "Hello" } }))
    s = reduce(
      s,
      event({
        channel: "C1",
        subtype: "message_changed",
        message: { ...reply, text: "Hello!", streaming_state: "completed" },
      }),
    )
    expect(s.messages[key]).toMatchObject({ text: "Hello!", streaming_state: "completed" })
    expect(s.threads[threadKey]?.keys).toEqual([key])
    expect(s.messages[threadKey]?.reply_count).toBe(1)
  })

  it("keeps an app's status until its next message in the thread", () => {
    let s = reduce(loaded(), status("is thinking…", { loading_messages: ["Reading", "Writing"], expires_in: 60 }))
    expect(s.statuses[threadKey]).toEqual({
      user: "UBOT",
      status: "is thinking…",
      loadingMessages: ["Reading", "Writing"],
      expires: 210,
    })
    // Someone else's reply, or the app's message elsewhere, leave it.
    s = reduce(s, event({ channel: "C1", ts: "0000000155.000000", thread_ts: head, user: "U2", text: "?" }))
    s = reduce(s, event({ channel: "C1", ts: "0000000156.000000", user: "UBOT", text: "elsewhere" }))
    expect(s.statuses[threadKey]?.status).toBe("is thinking…")
    s = reduce(s, event({ channel: "C1", ts: "0000000160.000000", thread_ts: head, user: "UBOT", text: "Answer" }))
    expect(s.statuses).toEqual({})
  })

  it("clears a status on an empty one, and times it out after two minutes by default", () => {
    let s = reduce(loaded(), status("is working"))
    expect(s.statuses[threadKey]).toEqual({ user: "UBOT", status: "is working", expires: 270 })
    s = reduce(s, status(""))
    expect(s.statuses).toEqual({})
    // Clearing what isn't there changes nothing.
    expect(reduce(s, status(""))).toBe(s)
    expect(reduce(s, status(undefined))).toBe(s)
  })

  it("drops the statuses it holds when a link (re)connects: the server sends the ones still showing", () => {
    let s = reduce(loaded(), status("is working"))
    s = reduce(s, { type: "connection", status: "disconnected" })
    expect(s.statuses[threadKey]).toBeDefined()
    s = reduce(s, { type: "connection", status: "connected" })
    expect(s.statuses).toEqual({})
    s = reduce(s, status("is still working"))
    expect(s.statuses[threadKey]?.status).toBe("is still working")
  })
})

describe("custom emoji", () => {
  const emoji = (change: Record<string, unknown>): Action => ({
    type: "event",
    event: { type: "emoji_changed", ...change },
  })
  const loaded: Action = {
    type: "emoji",
    emoji: { fiesta: "https://x.test/a.png", matsuri: "alias:fiesta", yay: "alias:+1" },
  }

  it("holds emoji.list and follows additions, removals and renames", () => {
    let s = run(loaded)
    expect(s.emoji).toEqual(loaded.type === "emoji" ? loaded.emoji : {})
    s = reduce(s, emoji({ subtype: "add", name: "fete", value: "https://x.test/b.gif" }))
    expect(s.emoji.fete).toBe("https://x.test/b.gif")
    s = reduce(s, emoji({ subtype: "rename", old_name: "fiesta", new_name: "festival", value: "https://x.test/a.png" }))
    expect(s.emoji).toMatchObject({ festival: "https://x.test/a.png", matsuri: "alias:festival", yay: "alias:+1" })
    expect(s.emoji.fiesta).toBeUndefined()
    s = reduce(s, emoji({ subtype: "remove", names: ["festival", "matsuri"] }))
    expect(Object.keys(s.emoji).toSorted()).toEqual(["fete", "yay"])
    // A rename without a value keeps the one held.
    s = reduce(s, emoji({ subtype: "rename", old_name: "fete", new_name: "fete-2" }))
    expect(s.emoji["fete-2"]).toBe("https://x.test/b.gif")
  })

  it("ignores emoji_changed it can't read", () => {
    const s = run(loaded)
    expect(reduce(s, emoji({ subtype: "other" }))).toBe(s)
    expect(reduce(s, emoji({ subtype: "add", name: "x" }))).toBe(s)
  })
})
