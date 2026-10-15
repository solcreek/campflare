import { afterEach, describe, expect, it } from "vitest"
import { keyOf, thread, timeline } from "../src/index"
import { createWorkspace } from "../src/workspace"
import { fakeApi, FakeSocket, settle, type Handler } from "../src/testing"

afterEach(() => {
  FakeSocket.all = []
})

const base: Record<string, Handler> = {
  "auth.test": () => ({ user_id: "U1", team_id: "T1", team: "Team" }),
  "team.info": () => ({ team: { name: "Campflare Dev" } }),
  "users.list": () => ({ members: [{ id: "U1", name: "alex" }] }),
  "conversations.list": () => ({
    channels: [{ id: "C1", name: "general", is_channel: true, is_member: true, last_read: "0000000000.000000" }],
  }),
  "rtm.connect": () => ({ url: "wss://rtm" }),
  "conversations.history": () => ({
    messages: [
      { ts: "0000000200.000000", user: "U1", text: "two" },
      { ts: "0000000100.000000", user: "U1", text: "one" },
    ],
    has_more: true,
  }),
}

async function started(handlers: Record<string, Handler> = {}, realtime: "rtm" | "none" = "none") {
  const api = fakeApi({ ...base, ...handlers })
  const ws = createWorkspace({
    client: api.client,
    realtime,
    WebSocket: FakeSocket as unknown as typeof WebSocket,
    minDelayMs: 1,
  })
  await ws.start()
  return { api, ws }
}

describe("createWorkspace", () => {
  it("loads who you are, people and conversations", async () => {
    const { ws } = await started()
    const s = ws.getState()
    expect(s.status).toBe("ready")
    expect(s.self).toEqual({ url: "https://x.test", userId: "U1", teamId: "T1", teamName: "Campflare Dev" })
    expect(Object.keys(s.users)).toEqual(["U1"])
    expect(Object.keys(s.conversations)).toEqual(["C1"])
  })

  it("falls back to auth.test's team name, and reports a failed start", async () => {
    const { ws } = await started({ "team.info": () => new Error("missing_scope") })
    expect(ws.getState().self?.teamName).toBe("Team")
    const bad = await started({ "auth.test": () => new Error("invalid_auth") })
    expect(bad.ws.getState()).toMatchObject({ status: "error", error: "invalid_auth" })
    expect(FakeSocket.all).toHaveLength(0)
    const broken = fakeApi({ ...base, "auth.test": () => ({}) })
    broken.client.call = () => Promise.reject(new TypeError("network down"))
    const offline = createWorkspace({ client: broken.client, realtime: "none" })
    await offline.start()
    expect(offline.getState().error).toBe("TypeError: network down")
  })

  it("starts once however often it's asked, and again after a stop or a failure", async () => {
    const api = fakeApi({ ...base })
    const ws = createWorkspace({ client: api.client, WebSocket: FakeSocket as unknown as typeof WebSocket })
    // Twice at once, as React's StrictMode does: one load, one link.
    await Promise.all([ws.start(), ws.start()])
    await settle()
    expect(api.calls.filter((c) => c.method === "auth.test")).toHaveLength(1)
    expect(FakeSocket.all).toHaveLength(1)
    await ws.start()
    expect(FakeSocket.all).toHaveLength(1)
    // Stopped, then started again: still loaded, and live again.
    ws.stop()
    await ws.start()
    await settle()
    expect(FakeSocket.all).toHaveLength(2)
    expect(api.calls.filter((c) => c.method === "auth.test")).toHaveLength(1)
    ws.stop()

    // Stopped while loading: it never goes live.
    const quiet = createWorkspace({ client: api.client, WebSocket: FakeSocket as unknown as typeof WebSocket })
    const starting = quiet.start()
    quiet.stop()
    await starting
    await settle()
    expect(FakeSocket.all).toHaveLength(2)

    // A failed start can be tried again.
    api.handlers["auth.test"] = () => new Error("fatal_error")
    const flaky = createWorkspace({ client: api.client, realtime: "none" })
    await flaky.start()
    expect(flaky.getState().status).toBe("error")
    api.handlers["auth.test"] = base["auth.test"]!
    await flaky.start()
    expect(flaky.getState().status).toBe("ready")
  })

  it("notifies subscribers until they unsubscribe", async () => {
    const { ws } = await started()
    let calls = 0
    const off = ws.subscribe(() => calls++)
    await ws.loadHistory("C1")
    expect(calls).toBe(1)
    off()
    await ws.loadHistory("C1", { older: true })
    expect(calls).toBe(1)
  })

  it("pages history from the oldest loaded message", async () => {
    const { api, ws } = await started()
    // Asking for older with nothing loaded loads the newest page.
    await ws.loadHistory("C1", { older: true })
    expect(api.calls.at(-1)?.args).toEqual({ channel: "C1", limit: "50" })
    await ws.loadHistory("C1", { older: true })
    expect(api.calls.at(-1)?.args).toEqual({ channel: "C1", limit: "50", latest: "0000000100.000000" })
  })

  it("loads a thread", async () => {
    const { ws } = await started({
      "conversations.replies": () => ({
        messages: [
          { ts: "0000000100.000000", thread_ts: "0000000100.000000", reply_count: 1 },
          { ts: "0000000150.000000", thread_ts: "0000000100.000000" },
        ],
      }),
    })
    await ws.loadReplies("C1", "0000000100.000000")
    expect(thread(ws.getState(), "C1", "0000000100.000000").map((m) => m.ts)).toEqual([
      "0000000100.000000",
      "0000000150.000000",
    ])
  })

  it("sends and swaps in the stored message", async () => {
    let sentArgs: Record<string, string> | undefined
    const { ws } = await started({
      "chat.postMessage": (args) => {
        sentArgs = args
        return { ts: "0000000300.000000", message: { ts: "0000000300.000000", text: args.text } }
      },
    })
    let pendingId: unknown
    ws.subscribe(() => (pendingId ??= timeline(ws.getState(), "C1")[0]?.client_msg_id))
    await ws.send("C1", "hello")
    expect(timeline(ws.getState(), "C1").map((m) => [m.ts, m.text, m.pending])).toEqual([
      ["0000000300.000000", "hello", undefined],
    ])
    // The pending message's client_msg_id goes to the server, which echoes it on RTM's copy.
    expect(pendingId).toMatch(/^[0-9a-f-]{36}$/)
    expect(sentArgs?.client_msg_id).toBe(pendingId)
  })

  it("shows a message as pending before the server answers", async () => {
    const { api, ws } = await started()
    let seen: unknown
    ws.subscribe(() => (seen ??= timeline(ws.getState(), "C1")[0]))
    // An answer without the message: the store builds it from what was sent.
    api.handlers["chat.postMessage"] = () => ({ ts: "0000000300.000000" })
    await ws.send("C1", "hi")
    expect(seen).toMatchObject({ pending: true, text: "hi", user: "U1" })
    expect(timeline(ws.getState(), "C1")[0]).toMatchObject({ ts: "0000000300.000000", text: "hi", user: "U1" })
  })

  it("keeps a failed message for retry or discard", async () => {
    const { api, ws } = await started({ "chat.postMessage": () => new Error("is_archived") })
    await ws.send("C1", "hello")
    const failed = timeline(ws.getState(), "C1")[0]!
    expect(failed).toMatchObject({ failed: "is_archived", pending: true })
    api.handlers["chat.postMessage"] = () => ({ ts: "0000000300.000000" })
    await ws.retry("C1", failed.ts)
    expect(timeline(ws.getState(), "C1").map((m) => m.ts)).toEqual(["0000000300.000000"])
    // Retrying what isn't failed does nothing.
    await ws.retry("C1", "0000000300.000000")
    expect(api.calls.filter((c) => c.method === "chat.postMessage")).toHaveLength(2)

    api.handlers["chat.postMessage"] = () => {
      throw new TypeError("offline")
    }
    api.client.call = (() => Promise.reject(new TypeError("offline"))) as typeof api.client.call
    await ws.send("C1", "again")
    const again = timeline(ws.getState(), "C1").at(-1)!
    expect(again.failed).toBe("TypeError: offline")
    ws.discard("C1", again.ts)
    expect(timeline(ws.getState(), "C1")).toHaveLength(1)
  })

  it("uploads files with a pending message, then shows the stored one", async () => {
    const stored = { ts: "0000000300.000000", user: "U1", text: "photos", files: [{ id: "F1", name: "café.png" }] }
    const { api, ws } = await started({
      "files.getUploadURLExternal": (args) => ({
        upload_url: `https://x.test/upload/v1/${args.filename}`,
        file_id: "F1",
      }),
      "files.completeUploadExternal": () => ({ files: [{ id: "F1", title: "café.png" }] }),
    })
    await ws.loadHistory("C1")
    api.handlers["conversations.history"] = () => ({ messages: [stored] })
    let pending: unknown
    ws.subscribe(() => (pending ??= timeline(ws.getState(), "C1").find((m) => m.pending)))
    const bytes = new Uint8Array([1, 2, 3])
    await ws.upload("C1", [{ name: "café.png", bytes, type: "image/png" }], { text: "photos" })
    expect(pending).toMatchObject({
      text: "photos",
      user: "U1",
      files: [{ name: "café.png", mimetype: "image/png", size: 3 }],
    })
    expect(new Uint8Array(api.files["https://x.test/upload/v1/café.png"] as ArrayBuffer)).toEqual(bytes)
    const complete = api.calls.find((c) => c.method === "files.completeUploadExternal")!
    expect(complete.args).toMatchObject({ channel_id: "C1", initial_comment: "photos" })
    expect(timeline(ws.getState(), "C1").map((m) => [m.ts, m.pending])).toEqual([
      ["0000000100.000000", undefined],
      ["0000000200.000000", undefined],
      ["0000000300.000000", undefined],
    ])

    // Into a thread, with no text: the thread is reloaded instead.
    api.handlers["conversations.replies"] = () => ({ messages: [{ ts: "0000000100.000000" }, stored] })
    await ws.upload("C1", [{ name: "notes.txt", bytes }], { threadTs: "0000000100.000000" })
    expect(api.calls.at(-2)!.args.initial_comment).toBeUndefined()
    expect(api.calls.at(-1)!.method).toBe("conversations.replies")
    await ws.upload("C1", [])
    expect(api.calls.at(-1)!.method).toBe("conversations.replies")
  })

  it("never shows an upload twice when RTM's copy beats the HTTP answer", async () => {
    const head = "0000000100.000000"
    let n = 0
    const { api, ws } = await started(
      {
        "files.getUploadURLExternal": (args) => ({
          upload_url: `https://x.test/upload/v1/${args.filename}`,
          file_id: `F${++n}`,
        }),
        "conversations.replies": () => ({ messages: [{ ts: head, thread_ts: head, reply_count: 1 }, stored()] }),
      },
      "rtm",
    )
    await settle()
    const socket = FakeSocket.all[0]!
    socket.receive({ type: "hello" })
    await ws.loadHistory("C1")
    let posted: Record<string, unknown> = {}
    const stored = () => posted
    // Completion posts the message, and RTM delivers it before completion's answer.
    api.handlers["files.completeUploadExternal"] = (args) => {
      const files = JSON.parse(args.files!) as { id: string }[]
      posted = { ts: `0000000${300 + n}.000000`, user: "U1", thread_ts: args.thread_ts, files }
      socket.receive({ type: "message", channel: "C1", ...posted })
      return { files }
    }
    api.handlers["conversations.history"] = () => ({
      messages: [posted, { ts: "0000000200.000000", user: "U1" }, { ts: head, user: "U1" }],
    })
    const copies: number[] = []
    ws.subscribe(() => {
      const s = ws.getState()
      copies.push(timeline(s, "C1").filter((m) => m.user === "U1" && m.files).length)
    })
    const bytes = new Uint8Array([1])
    await ws.upload("C1", [
      { name: "北京.png", bytes },
      { name: "Straße.txt", bytes },
    ])
    expect(Math.max(...copies)).toBe(1)
    expect(timeline(ws.getState(), "C1").map((m) => [m.ts, m.pending])).toEqual([
      [head, undefined],
      ["0000000200.000000", undefined],
      ["0000000302.000000", undefined],
    ])

    // In a thread: one reply, counted once.
    copies.length = 0
    ws.subscribe(() => {
      copies.push(thread(ws.getState(), "C1", head).filter((m) => m.files).length)
    })
    await ws.upload("C1", [{ name: "도쿄.jpg", bytes }], { threadTs: head })
    expect(Math.max(...copies)).toBe(1)
    expect(thread(ws.getState(), "C1", head).map((m) => [m.ts, m.pending])).toEqual([
      [head, undefined],
      ["0000000303.000000", undefined],
    ])
    expect(ws.getState().messages[keyOf("C1", head)]?.reply_count).toBe(1)
  })

  it("keeps a failed upload's files for retry", async () => {
    const { api, ws } = await started({ "files.getUploadURLExternal": () => new Error("file_too_large") })
    await ws.upload("C1", [{ name: "big.zip", bytes: new Uint8Array(4) }])
    const failed = timeline(ws.getState(), "C1")[0]!
    expect(failed).toMatchObject({ failed: "file_too_large", files: [{ name: "big.zip", size: 4 }] })
    api.handlers["files.getUploadURLExternal"] = () => ({ upload_url: "https://x.test/upload/v1/u", file_id: "F2" })
    api.handlers["files.completeUploadExternal"] = () => ({ files: [] })
    api.handlers["conversations.history"] = () => new Error("ratelimited")
    await ws.retry("C1", failed.ts)
    // The history reload failed, but the upload went through: the pending copy goes.
    expect(api.files["https://x.test/upload/v1/u"]).toBeDefined()
    expect(timeline(ws.getState(), "C1")).toEqual([])

    api.handlers["files.getUploadURLExternal"] = () => new Error("invalid_auth")
    await ws.upload("C1", [{ name: "a.txt", bytes: new Uint8Array(1) }])
    ws.discard("C1", timeline(ws.getState(), "C1")[0]!.ts)
    expect(timeline(ws.getState(), "C1")).toEqual([])
  })

  it("serves files' bytes with the session's token", async () => {
    const { api, ws } = await started()
    api.files["https://x.test/files-pri/T1-F1/a.png"] = "png"
    const blob = await ws.files.blob("https://x.test/files-pri/T1-F1/a.png")
    expect(await blob.text()).toBe("png")
    expect(api.fileRequests[0]!.headers.authorization).toBe("Bearer xoxp-1")
    await expect(ws.files.blob("https://elsewhere.test/x")).rejects.toThrow("not a file")
  })

  it("edits and deletes", async () => {
    const { ws } = await started({
      "chat.update": (args) => ({ message: { ts: args.ts, text: args.text, edited: { user: "U1", ts: "1" } } }),
      "chat.delete": () => ({}),
    })
    await ws.loadHistory("C1")
    await ws.edit("C1", "0000000200.000000", "TWO")
    expect(ws.getState().messages[keyOf("C1", "0000000200.000000")]?.text).toBe("TWO")
    await ws.remove("C1", "0000000200.000000")
    expect(timeline(ws.getState(), "C1").map((m) => m.ts)).toEqual(["0000000100.000000"])
  })

  it("reloads history when deleting a thread head, which leaves a tombstone", async () => {
    const { api, ws } = await started({
      "conversations.history": () => ({
        messages: [{ ts: "0000000100.000000", thread_ts: "0000000100.000000", reply_count: 2 }],
      }),
      "chat.delete": () => ({}),
    })
    await ws.loadHistory("C1")
    api.handlers["conversations.history"] = () => ({
      messages: [{ ts: "0000000100.000000", subtype: "tombstone", text: "This message was deleted." }],
    })
    await ws.remove("C1", "0000000100.000000")
    expect(timeline(ws.getState(), "C1")[0]?.subtype).toBe("tombstone")
  })

  it("loads, pins and unpins; loads, adds and removes bookmarks; saves messages", async () => {
    const pinned = { channel: "C1", created: 10, created_by: "U2", message: { ts: "0000000100.000000", text: "one" } }
    const { api, ws } = await started({
      "pins.list": () => ({ items: [pinned] }),
      "pins.add": () => ({}),
      "pins.remove": () => new Error("no_pin"),
      "bookmarks.list": () => ({ bookmarks: [] }),
      "bookmarks.add": (args) => ({
        bookmark: { id: "Bk1", channel_id: args.channel_id, title: args.title, link: args.link, rank: "0000000001" },
      }),
      "bookmarks.remove": () => ({}),
      "stars.add": () => new Error("already_starred"),
      "stars.remove": () => ({}),
    })
    await ws.loadHistory("C1")
    await ws.loadPins("C1")
    expect(ws.getState().pins.C1?.map((p) => p.ts)).toEqual(["0000000100.000000"])
    await ws.setPinned("C1", "0000000200.000000", true)
    expect(ws.getState().pins.C1?.map((p) => p.ts)).toEqual(["0000000200.000000", "0000000100.000000"])
    expect(ws.getState().messages[keyOf("C1", "0000000200.000000")]?.pinned_to).toEqual(["C1"])
    // Already unpinned on the server: no error, and the store agrees.
    await ws.setPinned("C1", "0000000200.000000", false)
    expect(ws.getState().pins.C1?.map((p) => p.ts)).toEqual(["0000000100.000000"])
    // A message the store doesn't hold: the pins are read again.
    await ws.setPinned("C1", "0000000900.000000", true)
    expect(api.calls.at(-1)?.method).toBe("pins.list")
    api.handlers["pins.add"] = () => new Error("too_many_pins")
    await expect(ws.setPinned("C1", "0000000200.000000", true)).rejects.toThrow("too_many_pins")

    await ws.loadBookmarks("C1")
    expect(ws.getState().bookmarks.C1).toEqual([])
    await ws.addBookmark("C1", "https://example.com/guía", { emoji: ":books:" })
    expect(api.calls.at(-1)?.args).toMatchObject({ type: "link", title: "https://example.com/guía", emoji: ":books:" })
    expect(ws.getState().bookmarks.C1?.map((b) => b.id)).toEqual(["Bk1"])
    await ws.addBookmark("C1", "https://example.com/wiki", { title: "Wiki" })
    expect(api.calls.at(-1)?.args).not.toHaveProperty("emoji")
    await ws.removeBookmark("C1", "Bk1")
    expect(ws.getState().bookmarks.C1).toEqual([])
    await ws.removeBookmark("C1", "Bk9")

    await ws.setSaved("C1", "0000000200.000000", true)
    expect(ws.getState().messages[keyOf("C1", "0000000200.000000")]?.is_starred).toBe(true)
    await ws.setSaved("C1", "0000000200.000000", false)
    expect(ws.getState().messages[keyOf("C1", "0000000200.000000")]?.is_starred).toBeUndefined()
  })

  it("toggles reactions, and undoes one the server refused", async () => {
    const { api, ws } = await started({ "reactions.add": () => ({}), "reactions.remove": () => ({}) })
    await ws.loadHistory("C1")
    const key = keyOf("C1", "0000000200.000000")
    await ws.toggleReaction("C1", "0000000200.000000", "eyes")
    expect(ws.getState().messages[key]?.reactions).toEqual([{ name: "eyes", users: ["U1"], count: 1 }])
    await ws.toggleReaction("C1", "0000000200.000000", "eyes")
    expect(ws.getState().messages[key]?.reactions).toEqual([])
    expect(api.calls.slice(-2).map((c) => c.method)).toEqual(["reactions.add", "reactions.remove"])

    api.handlers["reactions.add"] = () => new Error("too_many_reactions")
    await expect(ws.toggleReaction("C1", "0000000200.000000", "fire")).rejects.toThrow("too_many_reactions")
    expect(ws.getState().messages[key]?.reactions).toEqual([])
    // already_reacted means the server agrees it's there: keep it.
    api.handlers["reactions.add"] = () => new Error("already_reacted")
    await ws.toggleReaction("C1", "0000000200.000000", "fire")
    expect(ws.getState().messages[key]?.reactions?.map((r) => r.name)).toEqual(["fire"])
    // A reaction on a message the store doesn't hold still goes to the server.
    api.handlers["reactions.add"] = () => ({})
    await ws.toggleReaction("C1", "0000000999.000000", "eyes")
    expect(api.calls.at(-1)?.method).toBe("reactions.add")
  })

  it("clicks a button with campflare.blocks.action, and passes on the app's refusal", async () => {
    const { api, ws } = await started({ "campflare.blocks.action": () => ({ delivered: "http" }) })
    await ws.click("C1", "0000000200.000000", { blockId: "decide", actionId: "approve" })
    await ws.click("C1", "0000000200.000000", { blockId: "rate", actionId: "feedback", value: "up" })
    expect(api.calls.slice(-2)).toEqual([
      {
        method: "campflare.blocks.action",
        args: { channel: "C1", ts: "0000000200.000000", block_id: "decide", action_id: "approve" },
      },
      {
        method: "campflare.blocks.action",
        args: { channel: "C1", ts: "0000000200.000000", block_id: "rate", action_id: "feedback", value: "up" },
      },
    ])
    api.handlers["campflare.blocks.action"] = () => new Error("app_unreachable")
    await expect(ws.click("C1", "0000000200.000000", { blockId: "b", actionId: "a" })).rejects.toThrow(
      "app_unreachable",
    )
  })

  it("stops an app's stream with campflare.chat.stopStream, and passes on a refusal", async () => {
    const { api, ws } = await started({ "campflare.chat.stopStream": () => ({}) })
    await ws.stopStream("C1", "0000000200.000000")
    expect(api.calls.at(-1)).toEqual({
      method: "campflare.chat.stopStream",
      args: { channel: "C1", ts: "0000000200.000000" },
    })
    api.handlers["campflare.chat.stopStream"] = () => new Error("message_not_in_streaming_state")
    await expect(ws.stopStream("C1", "0000000200.000000")).rejects.toThrow("message_not_in_streaming_state")
  })

  it("follows the views open for you: listed at the start, changed live, submitted, closed", async () => {
    const form = { id: "V1", type: "modal", title: { text: "Deploy" }, blocks: [] }
    const pushed = { id: "V2", type: "modal", title: { text: "Sure?" }, blocks: [] }
    const { api, ws } = await started({
      "campflare.views.list": () => ({ views: [form] }),
      "campflare.views.submit": (args) =>
        JSON.parse(args.values!).note?.text === "x"
          ? { views: [form], errors: { note: "Too short" } }
          : { views: [form, pushed], delivered: "http" },
      "campflare.views.close": () => ({ views: [] }),
      "campflare.blocks.action": () => ({ delivered: "http" }),
    })
    await settle()
    expect(ws.getState().views).toEqual([form])
    expect(await ws.submitView("V1", { note: { text: "x" } })).toEqual({ errors: { note: "Too short" } })
    expect(await ws.submitView("V1", { note: { text: "Ship it" }, checks: { boxes: ["a", "b"] } })).toEqual({})
    expect(ws.getState().views.map((v) => v.id)).toEqual(["V1", "V2"])
    expect(api.calls.find((c) => c.method === "campflare.views.submit")?.args).toEqual({
      view_id: "V1",
      values: JSON.stringify({ note: { text: "x" } }),
    })
    await ws.clickInView("V2", { blockId: "b", actionId: "a", value: "v" }, { note: { text: "half" } })
    expect(api.calls.at(-1)).toEqual({
      method: "campflare.blocks.action",
      args: {
        view_id: "V2",
        block_id: "b",
        action_id: "a",
        value: "v",
        values: JSON.stringify({ note: { text: "half" } }),
      },
    })
    await ws.clickInView("V2", { blockId: "b", actionId: "a" })
    expect(api.calls.at(-1)?.args).toEqual({ view_id: "V2", block_id: "b", action_id: "a" })

    // A view the store doesn't hold is closed on the server all the same; one it holds goes at once.
    await ws.closeView("V9")
    expect(ws.getState().views).toEqual([])
    // A close the server refuses still closes it here.
    const reopened = await started({ "campflare.views.list": () => ({ views: [form, pushed] }) })
    await settle()
    reopened.api.handlers["campflare.views.close"] = () => new Error("not_found")
    await reopened.ws.closeView("V2")
    expect(reopened.ws.getState().views).toEqual([form])
  })

  it("takes views_changed over RTM, and lists views again after a reconnect", async () => {
    let listed = [{ id: "V1", type: "modal", blocks: [] }]
    const { ws } = await started({ "campflare.views.list": () => ({ views: listed }) }, "rtm")
    await settle()
    const link = FakeSocket.all[0]!
    link.receive({ type: "hello" })
    link.receive({ type: "views_changed", views: [] })
    expect(ws.getState().views).toEqual([])
    link.receive({ type: "views_changed" })
    expect(ws.getState().views).toEqual([])
    listed = [{ id: "V3", type: "modal", blocks: [] }]
    link.close()
    for (let i = 0; i < 50 && FakeSocket.all.length < 2; i++) await settle()
    FakeSocket.all[1]!.receive({ type: "hello" })
    await settle()
    expect(ws.getState().views.map((v) => v.id)).toEqual(["V3"])
    ws.stop()
  })

  it("marks read up to the newest message, once", async () => {
    const { api, ws } = await started({ "conversations.mark": () => ({}) })
    await ws.markRead("C1")
    expect(api.calls.some((c) => c.method === "conversations.mark")).toBe(false)
    await ws.loadHistory("C1")
    await ws.markRead("C1")
    expect(api.calls.at(-1)).toEqual({ method: "conversations.mark", args: { channel: "C1", ts: "0000000200.000000" } })
    expect(ws.getState().conversations.C1?.last_read).toBe("0000000200.000000")
    const count = api.calls.length
    await ws.markRead("C1")
    expect(api.calls.length).toBe(count)
  })

  it("joins, creates channels and opens DMs", async () => {
    const { api, ws } = await started({
      "conversations.join": (args) => ({ channel: { id: args.channel, name: "random", is_channel: true } }),
      "conversations.create": (args) => ({ channel: { id: "C9", name: args.name, is_channel: true } }),
      "conversations.open": () => ({ channel: { id: "D1" } }),
      "conversations.info": () => ({ channel: { id: "D1", is_im: true, user: "U2" } }),
    })
    await ws.join("C2")
    expect(ws.getState().conversations.C2?.is_member).toBe(true)
    expect(await ws.createChannel("ops", { isPrivate: true })).toBe("C9")
    expect(api.calls.at(-1)?.args).toEqual({ name: "ops", is_private: "true" })
    expect(ws.getState().conversations.C9).toMatchObject({ name: "ops", is_member: true })
    expect(await ws.openDm(["U2"])).toBe("D1")
    expect(ws.getState().conversations.D1?.user).toBe("U2")
    // Already known: no second lookup.
    await ws.openDm(["U2"])
    expect(api.calls.filter((c) => c.method === "conversations.info")).toHaveLength(1)
  })

  it("goes live over RTM and fills in what events mention", async () => {
    const { api, ws } = await started(
      {
        "users.info": (args) => ({ user: { id: args.user, name: "vincent" } }),
        "conversations.info": (args) => ({ channel: { id: args.channel, is_im: true, user: "U2" } }),
      },
      "rtm",
    )
    await settle()
    const socket = FakeSocket.all[0]!
    socket.receive({ type: "hello" })
    expect(ws.getState().connection).toBe("connected")
    socket.receive({ type: "message", channel: "D1", ts: "0000000300.000000", user: "U2", text: "hi" })
    // The same unknowns again while the lookups run: asked once.
    socket.receive({ type: "message", channel: "D1", ts: "0000000301.000000", user: "U2", text: "hi" })
    await settle()
    const s = ws.getState()
    expect(s.users.U2?.name).toBe("vincent")
    expect(s.conversations.D1?.user).toBe("U2")
    expect(s.unread.D1).toBe(2)
    expect(api.calls.filter((c) => c.method === "users.info")).toHaveLength(1)
    expect(api.calls.filter((c) => c.method === "conversations.info")).toHaveLength(1)
    ws.stop()
    expect(ws.getState().connection).toBe("offline")
  })

  it("ignores lookups that fail", async () => {
    const { ws } = await started(
      { "users.info": () => new Error("user_not_found"), "conversations.info": () => new Error("channel_not_found") },
      "rtm",
    )
    await settle()
    FakeSocket.all[0]!.receive({ type: "hello" })
    FakeSocket.all[0]!.receive({ type: "message", channel: "C7", ts: "0000000300.000000", user: "U7" })
    await settle()
    expect(ws.getState().users.U7).toBeUndefined()
    ws.stop()
  })

  it("catches up after a reconnect", async () => {
    const { api, ws } = await started({}, "rtm")
    await settle()
    FakeSocket.all[0]!.receive({ type: "hello" })
    await ws.loadHistory("C1")
    api.handlers["conversations.list"] = () => ({
      channels: [{ id: "C1", name: "general-renamed", is_channel: true, is_member: true }],
    })
    api.handlers["conversations.history"] = () => ({
      messages: [
        { ts: "0000000250.000000", user: "U2", text: "while you were away" },
        { ts: "0000000200.000000", user: "U1", text: "two" },
      ],
    })
    FakeSocket.all[0]!.close()
    expect(ws.getState().connection).toBe("disconnected")
    await new Promise((r) => setTimeout(r, 5))
    await settle()
    FakeSocket.all[1]!.receive({ type: "hello" })
    await settle()
    expect(ws.getState().conversations.C1?.name).toBe("general-renamed")
    expect(timeline(ws.getState(), "C1").map((m) => m.ts)).toEqual([
      "0000000100.000000",
      "0000000200.000000",
      "0000000250.000000",
    ])
    ws.stop()
  })

  it("reads loaded pins and bookmarks again after a reconnect", async () => {
    const pin = (ts: string) => ({ channel: "C1", created: 1, created_by: "U2", message: { ts, text: ts } })
    const bookmark = (id: string) => ({ id, channel_id: "C1", title: id, link: `https://example.com/${id}`, rank: id })
    const { api, ws } = await started(
      {
        "pins.list": () => ({ items: [pin("0000000100.000000")] }),
        "bookmarks.list": () => ({ bookmarks: [bookmark("Bk1")] }),
      },
      "rtm",
    )
    await settle()
    FakeSocket.all[0]!.receive({ type: "hello" })
    await ws.loadPins("C1")
    await ws.loadBookmarks("C1")
    // Missed while the link was down.
    api.handlers["pins.list"] = () => ({ items: [pin("0000000300.000000"), pin("0000000100.000000")] })
    api.handlers["bookmarks.list"] = () => ({ bookmarks: [] })
    api.handlers["conversations.history"] = () => new Error("ratelimited")
    FakeSocket.all[0]!.close()
    await new Promise((r) => setTimeout(r, 5))
    await settle()
    FakeSocket.all[1]!.receive({ type: "hello" })
    await settle()
    expect(ws.getState().pins.C1?.map((p) => p.ts)).toEqual(["0000000300.000000", "0000000100.000000"])
    expect(ws.getState().bookmarks.C1).toEqual([])
    ws.stop()
  })
})

describe("push and presence", () => {
  it("tells the server whether the person is looking, again after every reconnect", async () => {
    const { ws } = await started({}, "rtm")
    await settle()
    // Before the link is up: kept, and said once it is.
    ws.setActive(true)
    FakeSocket.all[0]!.receive({ type: "hello" })
    expect(FakeSocket.all[0]!.sent).toEqual([{ type: "campflare.active", active: true }])
    ws.setActive(false)
    expect(FakeSocket.all[0]!.sent.at(-1)).toEqual({ type: "campflare.active", active: false })
    FakeSocket.all[0]!.close()
    await new Promise((r) => setTimeout(r, 5))
    await settle()
    FakeSocket.all[1]!.receive({ type: "hello" })
    expect(FakeSocket.all[1]!.sent).toEqual([{ type: "campflare.active", active: false }])
    ws.stop()
  })

  it("subscribes and unsubscribes browsers, sends a test, and reads the key", async () => {
    const sub = { endpoint: "https://push.example/1", keys: { p256dh: "BPk", auth: "AAA" } }
    const { api, ws } = await started({
      "campflare.push.vapidKey": () => ({ key: "BKEY" }),
      "campflare.push.subscribe": () => ({ subscription: { id: "P1" } }),
      "campflare.push.unsubscribe": () => new Error("subscription_not_found"),
      "campflare.push.test": () => ({ sent: 2, failed: 0, removed: 1 }),
    })
    expect(await ws.pushKey()).toBe("BKEY")
    await ws.subscribePush(sub, "Firefox · Linux")
    expect(api.calls.at(-1)).toEqual({
      method: "campflare.push.subscribe",
      args: { subscription: JSON.stringify(sub), label: "Firefox · Linux" },
    })
    // Already gone is as good as removed.
    await ws.unsubscribePush(sub.endpoint)
    expect(api.calls.at(-1)).toEqual({ method: "campflare.push.unsubscribe", args: { endpoint: sub.endpoint } })
    expect(await ws.testPush()).toEqual({ sent: 2, failed: 0, removed: 1 })

    api.handlers["campflare.push.vapidKey"] = () => new Error("push_not_configured")
    expect(await ws.pushKey()).toBeNull()
    api.handlers["campflare.push.vapidKey"] = () => new Error("ratelimited")
    await expect(ws.pushKey()).rejects.toThrow("ratelimited")
    api.handlers["campflare.push.unsubscribe"] = () => new Error("invalid_auth")
    await expect(ws.unsubscribePush(sub.endpoint)).rejects.toThrow("invalid_auth")
  })
})
