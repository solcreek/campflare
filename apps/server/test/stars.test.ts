import { SELF } from "cloudflare:test"
import { env } from "cloudflare:workers"
import { describe, expect, it } from "vitest"
import { issueToken } from "../src/api/auth"
import { connect, expectError, ok, workspace } from "./helpers"

type Frame = Record<string, unknown>
type Item = { type: string; channel?: string; message?: Frame; file?: Frame; date_create: number }
type Listed = {
  items: Item[]
  paging: { per_page: number; page: number; total: number; pages: number }
  response_metadata: { next_cursor: string }
}

const post = async (token: string, channel: string, text: string, extra: Frame = {}) =>
  (await ok<{ ts: string }>("chat.postMessage", { channel, text, ...extra }, token)).ts

/** Uploads a small text file and shares it in `channel`. */
async function upload(token: string, channel: string, name: string) {
  const bytes = new TextEncoder().encode("Olá, 世界, 안녕")
  const reserved = await ok<{ upload_url: string; file_id: string }>(
    "files.getUploadURLExternal",
    { filename: name, length: bytes.length },
    token,
  )
  await SELF.fetch(reserved.upload_url, { method: "POST", body: bytes })
  await ok("files.completeUploadExternal", { files: [{ id: reserved.file_id }], channel_id: channel }, token)
  return reserved.file_id
}

/** Moves every star of a person back in time, so the next one sorts after them. */
const age = (userId: string) =>
  env.DB.prepare("UPDATE stars SET created = created - 10 WHERE user_id = ?").bind(userId).run()

describe("stars (saved items)", () => {
  it("saves messages, files and conversations, lists them newest first, and removes them", async () => {
    const w = await workspace()
    const bob = await w.addUser("bob")
    const ts = await post(w.owner.token, w.general, "À lire plus tard · 稍后阅读 · 나중에")
    const file = await upload(w.owner.token, w.general, "notas.txt")
    const dm = (await ok<{ channel: { id: string } }>("conversations.open", { users: w.owner.id }, bob.token)).channel
    const secret = await ok<{ channel: { id: string } }>(
      "conversations.create",
      { name: "secret", is_private: true },
      bob.token,
    )

    await ok("stars.add", { channel: w.general, timestamp: ts }, bob.token)
    await age(bob.id)
    await ok("stars.add", { file }, bob.token)
    await age(bob.id)
    await ok("stars.add", { channel: w.general }, bob.token)
    await age(bob.id)
    await ok("stars.add", { channel: dm.id }, bob.token)
    await age(bob.id)
    await ok("stars.add", { channel: secret.channel.id }, bob.token)
    await expectError("stars.add", { channel: w.general, timestamp: ts }, bob.token, "already_starred")

    const listed = await ok<Listed>("stars.list", {}, bob.token)
    expect(listed.items.map((i) => i.type)).toEqual(["group", "im", "channel", "file", "message"])
    expect(listed.paging).toMatchObject({ total: 5, page: 1, pages: 1 })
    expect(listed.items[3]!.file).toMatchObject({ id: file, name: "notas.txt", is_starred: true })
    expect(listed.items[4]).toMatchObject({
      channel: w.general,
      message: { ts, text: "À lire plus tard · 稍后阅读 · 나중에", is_starred: true },
    })
    expect(listed.items[4]!.message!.permalink).toContain(`/archives/${w.general}/p`)

    // Saved items are the person's own.
    expect((await ok<Listed>("stars.list", {}, w.owner.token)).items).toEqual([])

    await ok("stars.remove", { channel: w.general, timestamp: ts }, bob.token)
    await ok("stars.remove", { file }, bob.token)
    await ok("stars.remove", { channel: dm.id }, bob.token)
    await expectError("stars.remove", { file }, bob.token, "not_starred")
    expect((await ok<Listed>("stars.list", {}, bob.token)).items.map((i) => i.type)).toEqual(["group", "channel"])
  })

  it("marks the caller's saved messages is_starred in history and threads", async () => {
    const w = await workspace()
    const bob = await w.addUser("bob")
    const head = await post(w.owner.token, w.general, "head")
    const reply = await post(w.owner.token, w.general, "reply", { thread_ts: head })
    await ok("stars.add", { channel: w.general, timestamp: head }, bob.token)
    await ok("stars.add", { channel: w.general, timestamp: reply }, bob.token)
    const history = await ok<{ messages: Frame[] }>("conversations.history", { channel: w.general }, bob.token)
    expect(history.messages.find((m) => m.ts === head)!.is_starred).toBe(true)
    const own = await ok<{ messages: Frame[] }>("conversations.history", { channel: w.general }, w.owner.token)
    expect(own.messages.find((m) => m.ts === head)!.is_starred).toBeUndefined()
    const thread = await ok<{ messages: Frame[] }>("conversations.replies", { channel: w.general, ts: head }, bob.token)
    expect(thread.messages.map((m) => m.is_starred)).toEqual([true, true])
    const single = await ok<{ messages: Frame[] }>(
      "conversations.replies",
      { channel: w.general, ts: reply },
      bob.token,
    )
    expect(single.messages[0]!.is_starred).toBe(true)
  })

  it("pages by cursor and by page", async () => {
    const w = await workspace()
    const names = ["uno", "deux", "drei", "四", "五", "六"]
    for (const name of names) {
      const ts = await post(w.owner.token, w.general, name)
      await ok("stars.add", { channel: w.general, timestamp: ts }, w.owner.token)
    }
    const seen: string[] = []
    let cursor = ""
    do {
      const page = await ok<Listed>("stars.list", { limit: 4, cursor }, w.owner.token)
      seen.push(...page.items.map((i) => i.message!.text as string))
      cursor = page.response_metadata.next_cursor
    } while (cursor)
    expect(seen.toSorted()).toEqual(names.toSorted())
    expect(new Set(seen).size).toBe(6)

    const second = await ok<Listed>("stars.list", { count: 4, page: 2 }, w.owner.token)
    expect(second.items).toHaveLength(2)
    expect(second.paging).toEqual({ per_page: 4, spill: 0, page: 2, total: 6, pages: 2 })
  })

  it("forgets stars of deleted messages and files, and hides what the person can no longer read", async () => {
    const w = await workspace()
    const bob = await w.addUser("bob")
    const ts = await post(w.owner.token, w.general, "gone soon")
    await ok("stars.add", { channel: w.general, timestamp: ts }, bob.token)
    const file = await upload(w.owner.token, w.general, "temp.txt")
    await ok("stars.add", { file }, bob.token)
    const rtm = await connect((await ok<{ url: string }>("rtm.connect", {}, bob.token)).url)
    await rtm.next((f) => f.type === "hello")
    await ok("chat.delete", { channel: w.general, ts }, w.owner.token)
    expect(await rtm.next((f) => f.type === "star_removed")).toMatchObject({
      user: bob.id,
      item: { type: "message", channel: w.general, message: { ts, is_starred: false } },
    })
    await ok("files.delete", { file }, w.owner.token)
    expect(await rtm.next((f) => f.type === "star_removed")).toMatchObject({
      item: { type: "file", file: { id: file, is_starred: false } },
    })
    // A thread head stays as a tombstone, and its savers are told too.
    const head = await post(w.owner.token, w.general, "head")
    await post(w.owner.token, w.general, "reply", { thread_ts: head })
    await ok("stars.add", { channel: w.general, timestamp: head }, bob.token)
    await rtm.next((f) => f.type === "star_added")
    await ok("chat.delete", { channel: w.general, ts: head }, w.owner.token)
    expect(await rtm.next((f) => f.type === "star_removed")).toMatchObject({ item: { message: { ts: head } } })
    rtm.close()
    const left = await env.DB.prepare("SELECT COUNT(*) AS n FROM stars WHERE user_id = ?")
      .bind(bob.id)
      .first<{ n: number }>()
    expect(left!.n).toBe(0)

    // A private channel bob leaves drops out of his list.
    const { channel } = await ok<{ channel: { id: string } }>(
      "conversations.create",
      { name: "team-only", is_private: true },
      w.owner.token,
    )
    await ok("conversations.invite", { channel: channel.id, users: bob.id }, w.owner.token)
    const inside = await post(w.owner.token, channel.id, "inside")
    await ok("stars.add", { channel: channel.id, timestamp: inside }, bob.token)
    const privateFile = await upload(w.owner.token, channel.id, "privado.txt")
    await ok("stars.add", { file: privateFile }, bob.token)
    expect((await ok<Listed>("stars.list", {}, bob.token)).items).toHaveLength(2)
    await ok("conversations.leave", { channel: channel.id }, bob.token)
    const after = await ok<Listed>("stars.list", {}, bob.token)
    expect(after.items).toEqual([])
    expect(after.paging.total).toBe(0)
  })

  it("answers Slack's errors", async () => {
    const w = await workspace()
    const bob = await w.addUser("bob")
    await expectError("stars.add", {}, bob.token, "no_item_specified")
    await expectError("stars.add", { file_comment: "Fc1" }, bob.token, "file_comment_not_found")
    await expectError("stars.add", { file: "F0NOPE" }, bob.token, "file_not_found")
    await expectError("stars.add", { channel: "C0NOPE" }, bob.token, "channel_not_found")
    await expectError(
      "stars.add",
      { channel: w.general, timestamp: "1000000000.000001" },
      bob.token,
      "message_not_found",
    )
    await expectError("stars.remove", { channel: w.general }, bob.token, "not_starred")
    await expectError("stars.remove", {}, bob.token, "no_item_specified")
    await expectError("stars.remove", { file_comment: "Fc1" }, bob.token, "file_comment_not_found")

    const secret = await ok<{ channel: { id: string } }>(
      "conversations.create",
      { name: "secret", is_private: true },
      w.owner.token,
    )
    const hidden = await upload(w.owner.token, secret.channel.id, "hidden.txt")
    await expectError("stars.add", { channel: secret.channel.id }, bob.token, "channel_not_found")
    await expectError("stars.add", { file: hidden }, bob.token, "file_not_found")

    // Saved items are a person's: a bot has none.
    const app = await w.addApp("Saver")
    await expectError("stars.list", {}, app.botToken, "not_allowed_token_type")
  })

  it("sends star_added and star_removed to the person alone", async () => {
    const w = await workspace()
    const bob = await w.addUser("bob")
    const mine = await connect((await ok<{ url: string }>("rtm.connect", {}, bob.token)).url)
    const theirs = await connect((await ok<{ url: string }>("rtm.connect", {}, w.owner.token)).url)
    await mine.next((f) => f.type === "hello")
    await theirs.next((f) => f.type === "hello")
    const ts = await post(w.owner.token, w.general, "¡guárdalo!")
    await ok("stars.add", { channel: w.general, timestamp: ts }, bob.token)
    expect(await mine.next((f) => f.type === "star_added")).toMatchObject({
      user: bob.id,
      item: { type: "message", channel: w.general, message: { ts, is_starred: true } },
    })
    await ok("stars.remove", { channel: w.general, timestamp: ts }, bob.token)
    expect(await mine.next((f) => f.type === "star_removed")).toMatchObject({
      user: bob.id,
      item: { type: "message", message: { ts, is_starred: false } },
    })
    await ok("stars.add", { channel: w.general }, bob.token)
    expect(await mine.next((f) => f.type === "star_added")).toMatchObject({
      item: { type: "channel", channel: w.general },
    })
    await theirs.next((f) => f.type === "message")
    expect(theirs.frames.filter((f) => String(f.type).startsWith("star_"))).toEqual([])
    mine.close()
    theirs.close()
  })

  it("removes your own star after you lost access to what it names", async () => {
    const w = await workspace()
    const bob = await w.addUser("bob")
    const { channel } = await ok<{ channel: { id: string } }>(
      "conversations.create",
      { name: "für-kurz", is_private: true },
      w.owner.token,
    )
    await ok("conversations.invite", { channel: channel.id, users: bob.id }, w.owner.token)
    const ts = await post(w.owner.token, channel.id, "temporal · 一時的")
    const file = await upload(w.owner.token, channel.id, "brouillon.txt")
    await ok("stars.add", { channel: channel.id, timestamp: ts }, bob.token)
    await ok("stars.add", { channel: channel.id }, bob.token)
    await ok("stars.add", { file }, bob.token)
    await ok("conversations.kick", { channel: channel.id, user: bob.id }, w.owner.token)
    await expectError("stars.add", { channel: channel.id }, bob.token, "channel_not_found")

    const rtm = await connect((await ok<{ url: string }>("rtm.connect", {}, bob.token)).url)
    await rtm.next((f) => f.type === "hello")
    await ok("stars.remove", { channel: channel.id, timestamp: ts }, bob.token)
    // The event names the item and nothing more: bob can't read it now.
    expect(await rtm.next((f) => f.type === "star_removed")).toMatchObject({
      item: { type: "message", channel: channel.id, message: { ts, is_starred: false } },
    })
    await ok("stars.remove", { channel: channel.id }, bob.token)
    expect(await rtm.next((f) => f.type === "star_removed")).toMatchObject({
      item: { type: "group", channel: channel.id },
    })
    await ok("stars.remove", { file }, bob.token)
    expect(await rtm.next((f) => f.type === "star_removed")).toMatchObject({
      item: { type: "file", file: { id: file, is_starred: false } },
    })
    rtm.close()
    await expectError("stars.remove", { channel: channel.id, timestamp: ts }, bob.token, "not_starred")
    await expectError("stars.remove", { channel: "C0NOPE" }, bob.token, "not_starred")
    await expectError("stars.remove", { file: "F0NOPE" }, bob.token, "not_starred")
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM stars WHERE user_id = ?").bind(bob.id).first("n")).toBe(0)
  })

  it("wants stars:read to list and stars:write to save", async () => {
    const w = await workspace()
    const reader = await issueToken(env, {
      teamId: w.teamId,
      kind: "user",
      userId: w.owner.id,
      scopes: ["read"],
      label: "reader",
    })
    await ok("stars.list", {}, reader)
    await expectError("stars.add", { channel: w.general }, reader, "missing_scope")
  })
})
