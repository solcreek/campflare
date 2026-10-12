import { describe, expect, it } from "vitest"
import { expectError, ok, workspace } from "./helpers"

describe("reactions", () => {
  it("adds, groups, gets and removes reactions", async () => {
    const w = await workspace()
    const bob = await w.addUser("bob")
    const { ts } = await ok<{ ts: string }>("chat.postMessage", { channel: w.general, text: "nice" }, w.owner.token)
    await ok("reactions.add", { channel: w.general, timestamp: ts, name: "thumbsup" }, w.owner.token)
    await ok("reactions.add", { channel: w.general, timestamp: ts, name: ":thumbsup:" }, bob.token)
    await ok("reactions.add", { channel: w.general, timestamp: ts, name: "+1::skin-tone-3" }, bob.token)
    await expectError(
      "reactions.add",
      { channel: w.general, timestamp: ts, name: "thumbsup" },
      bob.token,
      "already_reacted",
    )
    await expectError(
      "reactions.add",
      { channel: w.general, timestamp: ts, name: "bad name" },
      bob.token,
      "invalid_name",
    )
    await expectError("reactions.add", { channel: w.general, name: "x" }, bob.token, "no_item_specified")
    await expectError(
      "reactions.add",
      { channel: w.general, timestamp: "1.000001", name: "x" },
      bob.token,
      "message_not_found",
    )

    const got = await ok<{ message: { reactions: unknown[]; permalink: string } }>(
      "reactions.get",
      { channel: w.general, timestamp: ts },
      bob.token,
    )
    expect(got.message.reactions).toEqual([
      { name: "thumbsup", users: [w.owner.id, bob.id], count: 2 },
      { name: "+1::skin-tone-3", users: [bob.id], count: 1 },
    ])
    expect(got.message.permalink).toContain(w.general)

    await ok("reactions.remove", { channel: w.general, timestamp: ts, name: "thumbsup" }, bob.token)
    await expectError(
      "reactions.remove",
      { channel: w.general, timestamp: ts, name: "thumbsup" },
      bob.token,
      "no_reaction",
    )
    const history = await ok<{ messages: { reactions?: unknown[] }[] }>(
      "conversations.history",
      { channel: w.general },
      bob.token,
    )
    expect(history.messages[0]!.reactions).toEqual([
      { name: "thumbsup", users: [w.owner.id], count: 1 },
      { name: "+1::skin-tone-3", users: [bob.id], count: 1 },
    ])
  })

  it("caps distinct reactions per message", async () => {
    const w = await workspace()
    const { ts } = await ok<{ ts: string }>("chat.postMessage", { channel: w.general, text: "x" }, w.owner.token)
    for (let i = 0; i < 50; i++)
      await ok("reactions.add", { channel: w.general, timestamp: ts, name: `e${i}` }, w.owner.token)
    await expectError(
      "reactions.add",
      { channel: w.general, timestamp: ts, name: "e50" },
      w.owner.token,
      "too_many_reactions",
    )
  })
})
