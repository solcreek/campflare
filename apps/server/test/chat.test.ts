import { describe, expect, it } from "vitest"
import { call, expectError, ok, workspace } from "./helpers"

type Posted = { channel: string; ts: string; message: Record<string, unknown> }
type Messages = { messages: Record<string, unknown>[] }

describe("chat.postMessage", () => {
  it("posts by channel id, #name or user id (a DM)", async () => {
    const w = await workspace()
    const bob = await w.addUser("bob")
    const byName = await ok<Posted>("chat.postMessage", { channel: "#general", text: "hi" }, w.owner.token)
    expect(byName).toMatchObject({ channel: w.general, message: { type: "message", text: "hi", user: w.owner.id } })
    expect(byName.ts).toMatch(/^\d{10}\.\d{6}$/)
    const toUser = await ok<Posted>("chat.postMessage", { channel: bob.id, text: "psst" }, w.owner.token)
    expect(toUser.channel).toMatch(/^D/)
    const history = await ok<Messages>("conversations.history", { channel: toUser.channel }, bob.token)
    expect(history.messages[0]).toMatchObject({ text: "psst" })
    await expectError("chat.postMessage", { channel: "#nope", text: "x" }, w.owner.token, "channel_not_found")
    await expectError("chat.postMessage", { channel: "UNOPE", text: "x" }, w.owner.token, "channel_not_found")
  })

  it("fills in a block_id on every block and an action_id on every action, keeping given ones", async () => {
    const w = await workspace()
    const blocks = [
      { type: "section", text: { type: "mrkdwn", text: "Ship it?" } },
      {
        type: "actions",
        block_id: "decide",
        elements: [
          { type: "button", text: { type: "plain_text", text: "Approve" }, action_id: "approve" },
          { type: "button", text: { type: "plain_text", text: "Later" } },
        ],
      },
      { type: "context_actions", elements: [{ type: "feedback_buttons" }] },
    ]
    const posted = await ok<Posted>("chat.postMessage", { channel: w.general, blocks }, w.owner.token)
    const stored = posted.message.blocks as { block_id: string; elements?: { action_id: string }[] }[]
    expect(stored[0]!.block_id).toMatch(/^[A-Za-z0-9]{5}$/)
    expect(stored[1]!.block_id).toBe("decide")
    expect(stored[1]!.elements![0]!.action_id).toBe("approve")
    expect(stored[1]!.elements![1]!.action_id).toMatch(/^[A-Za-z0-9]{5}$/)
    expect(stored[2]!.elements![0]!.action_id).toMatch(/^[A-Za-z0-9]{5}$/)
    // Updates fill them in too, and history has what was stored.
    const updated = await ok<Posted>(
      "chat.update",
      { channel: w.general, ts: posted.ts, blocks: [{ type: "divider" }] },
      w.owner.token,
    )
    expect(updated.message.blocks).toEqual([{ type: "divider", block_id: expect.any(String) }])
    const history = await ok<Messages>("conversations.history", { channel: w.general, limit: 1 }, w.owner.token)
    expect(history.messages[0]!.blocks).toEqual(updated.message.blocks)
  })

  it("keeps blocks, attachments and metadata, and needs some content", async () => {
    const w = await workspace()
    const blocks = [{ type: "section", text: { type: "mrkdwn", text: "*bold*" } }]
    const posted = await ok<Posted>(
      "chat.postMessage",
      { channel: w.general, blocks, attachments: [{ text: "att" }], metadata: { event_type: "x", event_payload: {} } },
      w.owner.token,
      { json: true },
    )
    expect(posted.message).toMatchObject({ blocks, attachments: [{ text: "att" }], metadata: { event_type: "x" } })
    await expectError("chat.postMessage", { channel: w.general }, w.owner.token, "no_text")
    await expectError("chat.postMessage", { channel: w.general, blocks: "{" }, w.owner.token, "invalid_blocks")
    await expectError("chat.postMessage", { channel: w.general, blocks: { a: 1 } }, w.owner.token, "invalid_blocks")
    await expectError(
      "chat.postMessage",
      { channel: w.general, attachments: { a: 1 } },
      w.owner.token,
      "invalid_attachments",
    )
    await expectError(
      "chat.postMessage",
      { channel: w.general, text: "x".repeat(40_001) },
      w.owner.token,
      "msg_too_long",
    )
    await expectError("chat.postMessage", { text: "x" }, w.owner.token, "channel_not_found")
  })

  it("posts as a bot, in public channels it hasn't joined", async () => {
    const w = await workspace()
    const app = await w.addApp("Deploy Bot")
    const posted = await ok<Posted>("chat.postMessage", { channel: w.general, text: "deployed" }, app.botToken)
    expect(posted.message).toMatchObject({
      user: app.botUserId,
      bot_id: app.botId,
      app_id: app.id,
      bot_profile: { id: app.botId, name: "Deploy Bot", app_id: app.id },
    })
    const { channel } = await ok<{ channel: { id: string } }>(
      "conversations.create",
      { name: "ops", is_private: true },
      w.owner.token,
    )
    await expectError("chat.postMessage", { channel: channel.id, text: "x" }, app.botToken, "channel_not_found")
    const custom = await ok<Posted>("chat.postMessage", { channel: w.general, text: "x", username: "CI" }, app.botToken)
    expect(custom.message).toMatchObject({ username: "CI" })
  })

  it("accepts client_msg_id and me messages", async () => {
    const w = await workspace()
    const posted = await ok<Posted>(
      "chat.postMessage",
      { channel: w.general, text: "x", client_msg_id: "abc" },
      w.owner.token,
    )
    expect(posted.message).toMatchObject({ client_msg_id: "abc" })
    await ok("chat.meMessage", { channel: w.general, text: "waves" }, w.owner.token)
    const history = await ok<Messages>("conversations.history", { channel: w.general, limit: 1 }, w.owner.token)
    expect(history.messages[0]).toMatchObject({ subtype: "me_message", text: "waves" })
  })
})

describe("chat.update and chat.delete", () => {
  it("edits your own messages only", async () => {
    const w = await workspace()
    const bob = await w.addUser("bob")
    const posted = await ok<Posted>("chat.postMessage", { channel: w.general, text: "teh" }, w.owner.token)
    const updated = await ok<Posted & { text: string }>(
      "chat.update",
      { channel: w.general, ts: posted.ts, text: "the" },
      w.owner.token,
    )
    expect(updated).toMatchObject({
      ts: posted.ts,
      text: "the",
      message: { text: "the", edited: { user: w.owner.id } },
    })
    await expectError("chat.update", { channel: w.general, ts: posted.ts, text: "x" }, bob.token, "cant_update_message")
    await expectError(
      "chat.update",
      { channel: w.general, ts: "1.000001", text: "x" },
      w.owner.token,
      "message_not_found",
    )
    await expectError("chat.update", { channel: w.general, text: "x" }, w.owner.token, "message_not_found")
    await expectError("chat.update", { channel: w.general, ts: posted.ts }, w.owner.token, "no_text")
  })

  it("deletes your own messages, and admins delete anyone's", async () => {
    const w = await workspace()
    const bob = await w.addUser("bob")
    const carol = await w.addUser("carol")
    const a = await ok<Posted>("chat.postMessage", { channel: w.general, text: "a" }, bob.token)
    const b = await ok<Posted>("chat.postMessage", { channel: w.general, text: "b" }, bob.token)
    await expectError("chat.delete", { channel: w.general, ts: a.ts }, carol.token, "cant_delete_message")
    await ok("chat.delete", { channel: w.general, ts: a.ts }, bob.token)
    await ok("chat.delete", { channel: w.general, ts: b.ts }, w.owner.token) // the owner is an admin
    await expectError("chat.delete", { channel: w.general, ts: a.ts }, bob.token, "message_not_found")
    const history = await ok<Messages>("conversations.history", { channel: w.general }, bob.token)
    expect(history.messages.filter((m) => m.text === "a" || m.text === "b")).toEqual([])
  })

  it("leaves a tombstone for a thread head, and recounts on reply deletion", async () => {
    const w = await workspace()
    const bob = await w.addUser("bob")
    const parent = await ok<Posted>("chat.postMessage", { channel: w.general, text: "p" }, w.owner.token)
    const r1 = await ok<Posted>("chat.postMessage", { channel: w.general, text: "r1", thread_ts: parent.ts }, bob.token)
    const r2 = await ok<Posted>(
      "chat.postMessage",
      { channel: w.general, text: "r2", thread_ts: parent.ts },
      w.owner.token,
    )
    const r3 = await ok<Posted>(
      "chat.postMessage",
      { channel: w.general, text: "r3", thread_ts: parent.ts },
      w.owner.token,
    )
    let thread = await ok<Messages>("conversations.replies", { channel: w.general, ts: parent.ts }, w.owner.token)
    expect(thread.messages[0]).toMatchObject({ reply_count: 3, reply_users: [bob.id, w.owner.id] })
    // Bob's only reply goes: he leaves the repliers. The latest reply goes: the one before it is latest.
    await ok("chat.delete", { channel: w.general, ts: r1.ts }, bob.token)
    await ok("chat.delete", { channel: w.general, ts: r3.ts }, w.owner.token)
    thread = await ok<Messages>("conversations.replies", { channel: w.general, ts: parent.ts }, w.owner.token)
    expect(thread.messages[0]).toMatchObject({ reply_count: 1, reply_users: [w.owner.id], latest_reply: r2.ts })
    await ok("chat.delete", { channel: w.general, ts: parent.ts }, w.owner.token)
    thread = await ok<Messages>("conversations.replies", { channel: w.general, ts: parent.ts }, w.owner.token)
    expect(thread.messages[0]).toMatchObject({ subtype: "tombstone", text: "This message was deleted." })
    expect(thread.messages.map((m) => m.text)).toEqual(["This message was deleted.", "r2"])
    await expectError("chat.delete", { channel: w.general, ts: parent.ts }, w.owner.token, "cant_delete_message")
  })
})

describe("chat.getPermalink and chat.postEphemeral", () => {
  it("builds permalinks, with the thread for replies", async () => {
    const w = await workspace()
    const parent = await ok<Posted>("chat.postMessage", { channel: w.general, text: "p" }, w.owner.token)
    const reply = await ok<Posted>(
      "chat.postMessage",
      { channel: w.general, text: "r", thread_ts: parent.ts },
      w.owner.token,
    )
    const p = await ok<{ permalink: string }>(
      "chat.getPermalink",
      { channel: w.general, message_ts: parent.ts },
      w.owner.token,
    )
    expect(p.permalink).toBe(`https://campflare.test/archives/${w.general}/p${parent.ts.replace(".", "")}`)
    const r = await ok<{ permalink: string }>(
      "chat.getPermalink",
      { channel: w.general, message_ts: reply.ts },
      w.owner.token,
    )
    expect(new URL(r.permalink).searchParams.get("thread_ts")).toBe(parent.ts)
    await expectError("chat.getPermalink", { channel: w.general }, w.owner.token, "message_not_found")
  })

  it("posts ephemeral messages only to channel members", async () => {
    const w = await workspace()
    const bob = await w.addUser("bob")
    const { channel } = await ok<{ channel: { id: string } }>("conversations.create", { name: "x" }, w.owner.token)
    const res = await ok<{ message_ts: string }>(
      "chat.postEphemeral",
      { channel: w.general, user: bob.id, text: "only you" },
      w.owner.token,
    )
    expect(res.message_ts).toMatch(/^\d{10}\.\d{6}$/)
    await expectError(
      "chat.postEphemeral",
      { channel: channel.id, user: bob.id, text: "x" },
      w.owner.token,
      "user_not_in_channel",
    )
    // Never stored.
    const history = await ok<Messages>("conversations.history", { channel: w.general }, bob.token)
    expect(history.messages.some((m) => m.text === "only you")).toBe(false)
    expect((await call("chat.postEphemeral", { channel: w.general, text: "x" }, w.owner.token)).error).toBe(
      "user_not_in_channel",
    )
  })
})
