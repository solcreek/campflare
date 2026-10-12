import { describe, expect, it } from "vitest"
import { expectError, ok, workspace } from "./helpers"

type Channel = {
  id: string
  name?: string
  is_member?: boolean
  unread_count?: number
  last_read?: string
  user?: string
}
type Messages = {
  messages: { ts: string; text: string; subtype?: string; thread_ts?: string; reply_count?: number }[]
  has_more: boolean
  response_metadata: { next_cursor: string }
}

describe("conversations", () => {
  it("creates channels and lists them by type and membership", async () => {
    const w = await workspace()
    const bob = await w.addUser("bob")
    const { channel: pub } = await ok<{ channel: Channel }>("conversations.create", { name: "Dev" }, w.owner.token)
    const { channel: priv } = await ok<{ channel: Channel }>(
      "conversations.create",
      { name: "secret", is_private: true },
      w.owner.token,
    )
    expect(pub).toMatchObject({ name: "dev", is_channel: true, is_private: false, is_member: true })
    await expectError("conversations.create", { name: "dev" }, w.owner.token, "name_taken")
    await expectError("conversations.create", { name: "Bad Name!" }, w.owner.token, "invalid_name_specials")
    await expectError("conversations.create", {}, w.owner.token, "invalid_name_required")

    // Bob sees public channels but not the private one he isn't in.
    const listed = await ok<{ channels: Channel[] }>(
      "conversations.list",
      { types: "public_channel,private_channel" },
      bob.token,
    )
    const names = listed.channels.map((c) => c.name)
    expect(names).toContain("dev")
    expect(names).toContain("general")
    expect(names).not.toContain("secret")
    await expectError("conversations.info", { channel: priv.id }, bob.token, "channel_not_found")
    await expectError("conversations.list", { types: "nope" }, bob.token, "invalid_types")

    const mine = await ok<{ channels: Channel[] }>(
      "users.conversations",
      { types: "public_channel,private_channel" },
      w.owner.token,
    )
    expect(mine.channels.map((c) => c.name).toSorted()).toEqual(["dev", "general", "secret"])
  })

  it("paginates conversations.list with cursors", async () => {
    const w = await workspace()
    for (const name of ["a1", "a2", "a3"]) await ok("conversations.create", { name }, w.owner.token)
    const seen: string[] = []
    let cursor: string | undefined
    do {
      const page = await ok<{ channels: Channel[]; response_metadata: { next_cursor: string } }>(
        "conversations.list",
        { limit: 2, cursor },
        w.owner.token,
      )
      seen.push(...page.channels.map((c) => c.name!))
      cursor = page.response_metadata.next_cursor || undefined
    } while (cursor)
    expect(seen.toSorted()).toEqual(["a1", "a2", "a3", "general"])
    await expectError("conversations.list", { cursor: "!!!" }, w.owner.token, "invalid_cursor")
  })

  it("joins, invites, kicks and leaves, posting system messages", async () => {
    const w = await workspace()
    const bob = await w.addUser("bob")
    const carol = await w.addUser("carol")
    const { channel } = await ok<{ channel: Channel }>("conversations.create", { name: "dev" }, w.owner.token)

    await expectError("chat.postMessage", { channel: channel.id, text: "hi" }, bob.token, "not_in_channel")
    await ok("conversations.join", { channel: channel.id }, bob.token)
    expect(await ok("conversations.join", { channel: channel.id }, bob.token)).toMatchObject({
      warning: "already_in_channel",
    })
    await ok("conversations.invite", { channel: channel.id, users: carol.id }, bob.token)
    await expectError("conversations.invite", { channel: channel.id, users: carol.id }, bob.token, "already_in_channel")
    await expectError("conversations.invite", { channel: channel.id, users: bob.id }, bob.token, "cant_invite_self")
    await expectError("conversations.invite", { channel: channel.id, users: "UNOPE" }, bob.token, "user_not_found")
    await expectError("conversations.invite", { channel: channel.id }, bob.token, "no_user")

    const members = await ok<{ members: string[] }>("conversations.members", { channel: channel.id }, bob.token)
    expect(members.members.toSorted()).toEqual([w.owner.id, bob.id, carol.id].toSorted())
    const paged = await ok<{ members: string[]; response_metadata: { next_cursor: string } }>(
      "conversations.members",
      { channel: channel.id, limit: 2 },
      bob.token,
    )
    expect(paged.members).toHaveLength(2)
    expect(paged.response_metadata.next_cursor).not.toBe("")

    await ok("conversations.kick", { channel: channel.id, user: carol.id }, w.owner.token)
    await expectError("conversations.kick", { channel: channel.id, user: carol.id }, w.owner.token, "not_in_channel")
    await expectError("conversations.kick", { channel: channel.id, user: w.owner.id }, w.owner.token, "cant_kick_self")
    await ok("conversations.leave", { channel: channel.id }, bob.token)
    expect(await ok("conversations.leave", { channel: channel.id }, bob.token)).toMatchObject({ not_in_channel: true })

    const history = await ok<Messages>("conversations.history", { channel: channel.id }, w.owner.token)
    expect(history.messages.map((m) => m.subtype)).toEqual(["channel_leave", "channel_join", "channel_join"])
  })

  it("protects #general", async () => {
    const w = await workspace()
    const bob = await w.addUser("bob")
    await expectError("conversations.leave", { channel: w.general }, bob.token, "cant_leave_general")
    await expectError(
      "conversations.kick",
      { channel: w.general, user: bob.id },
      w.owner.token,
      "cant_kick_from_general",
    )
    await expectError("conversations.archive", { channel: w.general }, w.owner.token, "cant_archive_general")
  })

  it("sets topic and purpose, renames, archives and unarchives", async () => {
    const w = await workspace()
    const { channel } = await ok<{ channel: Channel }>("conversations.create", { name: "dev" }, w.owner.token)
    const topic = await ok<{ channel: { topic: { value: string; creator: string } } }>(
      "conversations.setTopic",
      { channel: channel.id, topic: "Ship it" },
      w.owner.token,
    )
    expect(topic.channel.topic).toMatchObject({ value: "Ship it", creator: w.owner.id })
    await ok("conversations.setPurpose", { channel: channel.id, purpose: "Engineering" }, w.owner.token)
    await expectError(
      "conversations.setTopic",
      { channel: channel.id, topic: "x".repeat(251) },
      w.owner.token,
      "too_long",
    )

    const renamed = await ok<{ channel: { name: string; previous_names: string[] } }>(
      "conversations.rename",
      { channel: channel.id, name: "engineering" },
      w.owner.token,
    )
    expect(renamed.channel).toMatchObject({ name: "engineering", previous_names: ["dev"] })
    await expectError("conversations.rename", { channel: channel.id, name: "general" }, w.owner.token, "name_taken")
    expect(await ok("conversations.rename", { channel: channel.id, name: "engineering" }, w.owner.token)).toMatchObject(
      {
        channel: { name: "engineering" },
      },
    )

    await ok("conversations.archive", { channel: channel.id }, w.owner.token)
    await expectError("conversations.archive", { channel: channel.id }, w.owner.token, "already_archived")
    await expectError("chat.postMessage", { channel: channel.id, text: "hi" }, w.owner.token, "is_archived")
    await expectError("conversations.join", { channel: channel.id }, w.owner.token, "is_archived")
    const listed = await ok<{ channels: Channel[] }>("conversations.list", { exclude_archived: true }, w.owner.token)
    expect(listed.channels.map((c) => c.id)).not.toContain(channel.id)
    await ok("conversations.unarchive", { channel: channel.id }, w.owner.token)
    await expectError("conversations.unarchive", { channel: channel.id }, w.owner.token, "not_archived")

    const history = await ok<Messages>("conversations.history", { channel: channel.id }, w.owner.token)
    expect(history.messages.map((m) => m.subtype)).toEqual(["channel_name", "channel_purpose", "channel_topic"])
  })

  it("opens DMs and group DMs once, with Slack's naming", async () => {
    const w = await workspace()
    const bob = await w.addUser("bob")
    const carol = await w.addUser("carol")
    const dm = await ok<{ channel: Channel }>("conversations.open", { users: bob.id }, w.owner.token)
    expect(dm.channel.id).toMatch(/^D/)
    const again = await ok<{ channel: Channel }>(
      "conversations.open",
      { users: w.owner.id, return_im: true },
      bob.token,
    )
    // From bob's side it's the same DM, with the owner as its user.
    const bobsView = await ok<{ channel: Channel }>(
      "conversations.open",
      { users: w.owner.id, return_im: true },
      bob.token,
    )
    expect(bobsView.channel).toMatchObject({ id: dm.channel.id, is_im: true, user: w.owner.id })
    expect(again.channel.id).toBe(dm.channel.id)

    const self = await ok<{ channel: Channel }>(
      "conversations.open",
      { users: w.owner.id, return_im: true },
      w.owner.token,
    )
    expect(self.channel).toMatchObject({ is_im: true, user: w.owner.id })
    expect(self.channel.id).not.toBe(dm.channel.id)

    const group = await ok<{ channel: Channel & { is_mpim: boolean } }>(
      "conversations.open",
      { users: `${bob.id},${carol.id}` },
      w.owner.token,
    )
    expect(group.channel).toMatchObject({ is_mpim: true, name: "mpdm-bob--carol--owner-1" })
    expect(await ok("conversations.open", { channel: group.channel.id }, carol.token)).toMatchObject({
      channel: { id: group.channel.id },
    })

    await expectError("conversations.open", {}, w.owner.token, "users_list_not_supplied")
    await expectError("conversations.open", { users: "UNOPE" }, w.owner.token, "user_not_found")
    expect(await ok("conversations.close", { channel: dm.channel.id }, w.owner.token)).toMatchObject({ no_op: true })
    await expectError(
      "conversations.close",
      { channel: w.general },
      w.owner.token,
      "method_not_supported_for_channel_type",
    )
    await expectError(
      "conversations.join",
      { channel: dm.channel.id },
      carol.token,
      "method_not_supported_for_channel_type",
    )
    await expectError("conversations.history", { channel: dm.channel.id }, carol.token, "channel_not_found")

    const ims = await ok<{ channels: Channel[] }>("users.conversations", { types: "im,mpim" }, w.owner.token)
    expect(ims.channels).toHaveLength(3)
  })

  it("tracks read state with conversations.mark", async () => {
    const w = await workspace()
    const bob = await w.addUser("bob")
    const dm = await ok<{ channel: Channel }>("conversations.open", { users: bob.id }, w.owner.token)
    const first = await ok<{ ts: string }>("chat.postMessage", { channel: dm.channel.id, text: "one" }, bob.token)
    await ok("chat.postMessage", { channel: dm.channel.id, text: "two" }, bob.token)
    await ok("chat.postMessage", { channel: dm.channel.id, text: "mine" }, w.owner.token)
    let info = await ok<{ channel: Channel }>("conversations.info", { channel: dm.channel.id }, w.owner.token)
    expect(info.channel).toMatchObject({ unread_count: 2, last_read: "0000000000.000000" })
    await ok("conversations.mark", { channel: dm.channel.id, ts: first.ts }, w.owner.token)
    info = await ok<{ channel: Channel }>("conversations.info", { channel: dm.channel.id }, w.owner.token)
    expect(info.channel).toMatchObject({ unread_count: 1, last_read: first.ts })
    await expectError("conversations.mark", { channel: dm.channel.id }, w.owner.token, "invalid_timestamp")
    await expectError("conversations.mark", { channel: dm.channel.id, ts: "x" }, w.owner.token, "invalid_arguments")

    const counted = await ok<{ channel: { num_members: number } }>(
      "conversations.info",
      { channel: w.general, include_num_members: true },
      w.owner.token,
    )
    expect(counted.channel.num_members).toBe(2)
  })
})

describe("history and threads", () => {
  it("returns a full default page, past D1's 100 bound parameters", async () => {
    const w = await workspace()
    const posted: string[] = []
    for (let i = 0; i < 101; i++) {
      posted.push(
        (await ok<{ ts: string }>("chat.postMessage", { channel: w.general, text: `n${i}` }, w.owner.token)).ts,
      )
    }
    await ok("reactions.add", { channel: w.general, timestamp: posted[1], name: "tada" }, w.owner.token)
    const page = await ok<Messages & { messages: { reactions?: { name: string }[] }[] }>(
      "conversations.history",
      { channel: w.general },
      w.owner.token,
    )
    expect(page.messages).toHaveLength(100)
    expect(page.has_more).toBe(true)
    expect(page.messages.at(-1)).toMatchObject({ text: "n1", reactions: [{ name: "tada" }] })
  })

  it("pages history newest first, with latest/oldest/inclusive", async () => {
    const w = await workspace()
    const ts: string[] = []
    for (let i = 0; i < 5; i++) {
      ts.push((await ok<{ ts: string }>("chat.postMessage", { channel: w.general, text: `m${i}` }, w.owner.token)).ts)
    }
    const page1 = await ok<Messages>("conversations.history", { channel: w.general, limit: 2 }, w.owner.token)
    expect(page1.messages.map((m) => m.text)).toEqual(["m4", "m3"])
    expect(page1.has_more).toBe(true)
    const page2 = await ok<Messages>(
      "conversations.history",
      { channel: w.general, limit: 2, cursor: page1.response_metadata.next_cursor },
      w.owner.token,
    )
    expect(page2.messages.map((m) => m.text)).toEqual(["m2", "m1"])

    const before = await ok<Messages>("conversations.history", { channel: w.general, latest: ts[2] }, w.owner.token)
    expect(before.messages.map((m) => m.text)).toEqual(["m1", "m0"])
    const incl = await ok<Messages>(
      "conversations.history",
      { channel: w.general, latest: ts[2], oldest: ts[1], inclusive: true },
      w.owner.token,
    )
    expect(incl.messages.map((m) => m.text)).toEqual(["m2", "m1"])
    // Only `oldest`: the page nearest it, still newest first.
    const after = await ok<Messages>(
      "conversations.history",
      { channel: w.general, oldest: ts[0], limit: 2 },
      w.owner.token,
    )
    expect(after.messages.map((m) => m.text)).toEqual(["m2", "m1"])
    expect(after.has_more).toBe(true)

    await expectError("conversations.history", {}, w.owner.token, "channel_not_found")
    await expectError("conversations.history", { channel: "CNOPE" }, w.owner.token, "channel_not_found")
  })

  it("keeps replies in their thread unless broadcast", async () => {
    const w = await workspace()
    const bob = await w.addUser("bob")
    const parent = await ok<{ ts: string }>("chat.postMessage", { channel: w.general, text: "parent" }, w.owner.token)
    const r1 = await ok<{ ts: string; message: { parent_user_id: string; thread_ts: string } }>(
      "chat.postMessage",
      { channel: w.general, text: "reply", thread_ts: parent.ts },
      bob.token,
    )
    expect(r1.message).toMatchObject({ thread_ts: parent.ts, parent_user_id: w.owner.id })
    // A reply to a reply lands in the same thread.
    await ok("chat.postMessage", { channel: w.general, text: "nested", thread_ts: r1.ts }, w.owner.token)
    await ok(
      "chat.postMessage",
      { channel: w.general, text: "loud", thread_ts: parent.ts, reply_broadcast: true },
      bob.token,
    )

    const history = await ok<Messages>("conversations.history", { channel: w.general }, w.owner.token)
    expect(history.messages.map((m) => m.text)).toEqual(["loud", "parent"])
    expect(history.messages[1]).toMatchObject({
      reply_count: 3,
      thread_ts: parent.ts,
      reply_users: [bob.id, w.owner.id],
    })

    const thread = await ok<Messages>("conversations.replies", { channel: w.general, ts: parent.ts }, w.owner.token)
    expect(thread.messages.map((m) => m.text)).toEqual(["parent", "reply", "nested", "loud"])
    const paged = await ok<Messages>(
      "conversations.replies",
      { channel: w.general, ts: parent.ts, limit: 2 },
      w.owner.token,
    )
    // The parent counts toward the limit, as in Slack.
    expect(paged.messages.map((m) => m.text)).toEqual(["parent", "reply"])
    expect(paged.has_more).toBe(true)
    const rest = await ok<Messages>(
      "conversations.replies",
      { channel: w.general, ts: parent.ts, cursor: paged.response_metadata.next_cursor },
      w.owner.token,
    )
    expect(rest.messages.map((m) => m.text)).toEqual(["parent", "nested", "loud"])
    const windowed = await ok<Messages>(
      "conversations.replies",
      { channel: w.general, ts: parent.ts, oldest: r1.ts, latest: r1.ts, inclusive: true },
      w.owner.token,
    )
    expect(windowed.messages.map((m) => m.text)).toEqual(["parent", "reply"])

    const single = await ok<Messages>("conversations.replies", { channel: w.general, ts: r1.ts }, w.owner.token)
    expect(single.messages.map((m) => m.text)).toEqual(["reply"])
    await expectError("conversations.replies", { channel: w.general }, w.owner.token, "thread_not_found")
    await expectError(
      "conversations.replies",
      { channel: w.general, ts: "1.000001" },
      w.owner.token,
      "message_not_found",
    )
    await expectError(
      "chat.postMessage",
      { channel: w.general, text: "x", thread_ts: "1.000001" },
      w.owner.token,
      "thread_not_found",
    )
  })
})
