import { env } from "cloudflare:workers"
import { describe, expect, it } from "vitest"
import { issueToken } from "../src/api/auth"
import { connect, expectError, ok, workspace } from "./helpers"

type Frame = Record<string, unknown>
type Item = { type: string; channel: string; created: number; created_by: string; message: Frame }

const post = async (token: string, channel: string, text: string, extra: Frame = {}) =>
  (await ok<{ ts: string }>("chat.postMessage", { channel, text, ...extra }, token)).ts

describe("pins", () => {
  it("pins, lists and unpins a message, marking it pinned_to in history", async () => {
    const w = await workspace()
    const bob = await w.addUser("bob")
    const first = await post(w.owner.token, w.general, "Reunión a las 10 · 会议 · 회의")
    const second = await post(bob.token, w.general, "Café über alles")
    await ok("pins.add", { channel: w.general, timestamp: first }, bob.token)
    await ok("pins.add", { channel: w.general, timestamp: second }, w.owner.token)
    await expectError("pins.add", { channel: w.general, timestamp: first }, w.owner.token, "already_pinned")

    const { items } = await ok<{ items: Item[] }>("pins.list", { channel: w.general }, bob.token)
    expect(items.map((i) => i.message.ts)).toEqual([second, first].toSorted().toReversed())
    const pinnedFirst = items.find((i) => i.message.ts === first)!
    expect(pinnedFirst).toMatchObject({
      type: "message",
      channel: w.general,
      created_by: bob.id,
      message: { text: "Reunión a las 10 · 会议 · 회의", pinned_to: [w.general], user: w.owner.id },
    })
    expect(pinnedFirst.message.permalink).toContain(`/archives/${w.general}/p`)

    const history = await ok<{ messages: Frame[]; pin_count: number }>(
      "conversations.history",
      { channel: w.general },
      bob.token,
    )
    expect(history.pin_count).toBe(2)
    expect(history.messages.find((m) => m.ts === first)!.pinned_to).toEqual([w.general])

    await ok("pins.remove", { channel: w.general, timestamp: first }, w.owner.token)
    await expectError("pins.remove", { channel: w.general, timestamp: first }, w.owner.token, "no_pin")
    const after = await ok<{ messages: Frame[]; pin_count: number }>(
      "conversations.history",
      { channel: w.general },
      bob.token,
    )
    expect(after.pin_count).toBe(1)
    expect(after.messages.find((m) => m.ts === first)!.pinned_to).toBeUndefined()
  })

  it("answers Slack's errors", async () => {
    const w = await workspace()
    const bob = await w.addUser("bob")
    const ts = await post(w.owner.token, w.general, "hej")
    await expectError("pins.add", { channel: w.general }, w.owner.token, "no_item_specified")
    await expectError("pins.add", { channel: w.general, file: "F123" }, w.owner.token, "not_pinnable")
    await expectError("pins.add", { channel: "C0NOPE", timestamp: ts }, w.owner.token, "channel_not_found")
    await expectError(
      "pins.add",
      { channel: w.general, timestamp: "1000000000.000001" },
      w.owner.token,
      "message_not_found",
    )
    await expectError("pins.remove", { channel: w.general, timestamp: ts }, w.owner.token, "no_pin")

    // A public channel bob isn't in: he may read its pins, not change them.
    const { channel } = await ok<{ channel: { id: string } }>("conversations.create", { name: "plans" }, w.owner.token)
    const planned = await post(w.owner.token, channel.id, "plan")
    await ok("pins.add", { channel: channel.id, timestamp: planned }, w.owner.token)
    await expectError("pins.add", { channel: channel.id, timestamp: planned }, bob.token, "not_in_channel")
    expect((await ok<{ items: Item[] }>("pins.list", { channel: channel.id }, bob.token)).items).toHaveLength(1)

    // A private one is not there at all for him.
    const secret = await ok<{ channel: { id: string } }>(
      "conversations.create",
      { name: "secret", is_private: true },
      w.owner.token,
    )
    const hidden = await post(w.owner.token, secret.channel.id, "shh")
    await expectError("pins.list", { channel: secret.channel.id }, bob.token, "channel_not_found")
    await expectError("pins.add", { channel: secret.channel.id, timestamp: hidden }, bob.token, "channel_not_found")

    // Archived: no new pins.
    await ok("conversations.archive", { channel: channel.id }, w.owner.token)
    await expectError("pins.remove", { channel: channel.id, timestamp: planned }, w.owner.token, "is_archived")
  })

  it("won't pin a deleted thread head, and caps pins per conversation", async () => {
    const w = await workspace()
    const head = await post(w.owner.token, w.general, "head")
    await post(w.owner.token, w.general, "reply", { thread_ts: head })
    await ok("chat.delete", { channel: w.general, ts: head }, w.owner.token)
    await expectError("pins.add", { channel: w.general, timestamp: head }, w.owner.token, "not_pinnable")

    // 100 pinned messages, written directly.
    await env.DB.prepare(
      `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 100)
       INSERT INTO messages (channel_id, ts, team_id, user_id, text, pinned_by, pinned_at)
       SELECT ?, printf('1000000000.%06d', i), ?, ?, 'old', ?, 1 FROM n`,
    )
      .bind(w.general, w.teamId, w.owner.id, w.owner.id)
      .run()
    const ts = await post(w.owner.token, w.general, "one too many")
    await expectError("pins.add", { channel: w.general, timestamp: ts }, w.owner.token, "too_many_pins")
  })

  it("sends pin_added and pin_removed to the members, and unpins a message when it's deleted", async () => {
    const w = await workspace()
    const bob = await w.addUser("bob")
    const rtm = await connect((await ok<{ url: string }>("rtm.connect", {}, bob.token)).url)
    await rtm.next((f) => f.type === "hello")
    const ts = await post(w.owner.token, w.general, "¡pin me! 置顶")
    await ok("pins.add", { channel: w.general, timestamp: ts }, w.owner.token)
    const added = await rtm.next((f) => f.type === "pin_added")
    expect(added).toMatchObject({
      user: w.owner.id,
      channel_id: w.general,
      item_user: w.owner.id,
      pin_count: "1",
      pinned_info: { channel: w.general, pinned_by: w.owner.id },
      item: { type: "message", channel: w.general, created_by: w.owner.id, message: { ts, pinned_to: [w.general] } },
    })

    await ok("pins.remove", { channel: w.general, timestamp: ts }, w.owner.token)
    expect(await rtm.next((f) => f.type === "pin_removed")).toMatchObject({
      channel_id: w.general,
      pin_count: "0",
      has_pins: false,
    })

    // Deleting a pinned message unpins it, and says so.
    await ok("pins.add", { channel: w.general, timestamp: ts }, w.owner.token)
    await rtm.next((f) => f.type === "pin_added")
    await ok("chat.delete", { channel: w.general, ts }, w.owner.token)
    expect(await rtm.next((f) => f.type === "pin_removed")).toMatchObject({ pin_count: "0", has_pins: false })
    expect((await ok<{ items: Item[] }>("pins.list", { channel: w.general }, bob.token)).items).toEqual([])

    // So does deleting a pinned thread head, which stays as a tombstone.
    const head = await post(w.owner.token, w.general, "head")
    await post(bob.token, w.general, "reply", { thread_ts: head })
    await ok("pins.add", { channel: w.general, timestamp: head }, w.owner.token)
    await rtm.next((f) => f.type === "pin_added")
    await ok("chat.delete", { channel: w.general, ts: head }, w.owner.token)
    expect(await rtm.next((f) => f.type === "pin_removed")).toMatchObject({ item: { message: { ts: head } } })
    const { messages } = await ok<{ messages: Frame[] }>("conversations.history", { channel: w.general }, bob.token)
    expect(messages.find((m) => m.ts === head)).toMatchObject({ subtype: "tombstone" })
    expect(messages.find((m) => m.ts === head)!.pinned_to).toBeUndefined()
    rtm.close()
  })

  it("wants pins:read to list and pins:write to change", async () => {
    const w = await workspace()
    const ts = await post(w.owner.token, w.general, "x")
    const reader = await issueToken(env, {
      teamId: w.teamId,
      kind: "user",
      userId: w.owner.id,
      scopes: ["read"],
      label: "reader",
    })
    await ok("pins.list", { channel: w.general }, reader)
    await expectError("pins.add", { channel: w.general, timestamp: ts }, reader, "missing_scope")
    const writer = await issueToken(env, {
      teamId: w.teamId,
      kind: "user",
      userId: w.owner.id,
      scopes: ["write"],
      label: "writer",
    })
    await ok("pins.add", { channel: w.general, timestamp: ts }, writer)
  })

  it("lets an app's bot pin in a conversation it's in", async () => {
    const w = await workspace()
    const app = await w.addApp("Pinner")
    await ok("conversations.join", { channel: w.general }, app.botToken)
    const ts = await post(app.botToken, w.general, "from the bot")
    await ok("pins.add", { channel: w.general, timestamp: ts }, app.botToken)
    const { items } = await ok<{ items: Item[] }>("pins.list", { channel: w.general }, app.botToken)
    expect(items[0]).toMatchObject({ created_by: app.botUserId, message: { bot_id: app.botId } })
  })
})
