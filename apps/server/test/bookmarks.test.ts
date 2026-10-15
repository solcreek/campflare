import { env } from "cloudflare:workers"
import { describe, expect, it } from "vitest"
import { issueToken } from "../src/api/auth"
import { connect, expectError, ok, workspace } from "./helpers"

type Bookmark = {
  id: string
  channel_id: string
  title: string
  link: string
  emoji: string
  type: string
  rank: string
  date_created: number
  date_updated: number
  last_updated_by_user_id: string
  app_id: string | null
}

describe("bookmarks", () => {
  it("adds, lists in order, edits and removes links", async () => {
    const w = await workspace()
    const bob = await w.addUser("bob")
    const first = await ok<{ bookmark: Bookmark }>(
      "bookmarks.add",
      {
        channel_id: w.general,
        type: "link",
        title: "Guía de estilo",
        link: "https://example.com/guía",
        emoji: "books",
      },
      w.owner.token,
    )
    expect(first.bookmark).toMatchObject({
      channel_id: w.general,
      title: "Guía de estilo",
      link: "https://example.com/guía",
      emoji: ":books:",
      type: "link",
      date_updated: 0,
      last_updated_by_user_id: w.owner.id,
      app_id: null,
    })
    expect(first.bookmark.id).toMatch(/^Bk[A-Z0-9]+$/)
    await ok(
      "bookmarks.add",
      { channel_id: w.general, type: "link", title: "設計ドキュメント", link: "http://example.com/設計" },
      bob.token,
    )
    await ok(
      "bookmarks.add",
      { channel_id: w.general, type: "link", title: "회의록 · Übersicht", link: "https://example.com/notes" },
      bob.token,
    )
    const listed = await ok<{ bookmarks: Bookmark[] }>("bookmarks.list", { channel_id: w.general }, bob.token)
    expect(listed.bookmarks.map((b) => b.title)).toEqual(["Guía de estilo", "設計ドキュメント", "회의록 · Übersicht"])
    expect(listed.bookmarks.map((b) => b.rank)).toEqual(listed.bookmarks.map((b) => b.rank).toSorted())

    const edited = await ok<{ bookmark: Bookmark }>(
      "bookmarks.edit",
      { channel_id: w.general, bookmark_id: first.bookmark.id, title: "Style guide", emoji: ":memo:" },
      bob.token,
    )
    expect(edited.bookmark).toMatchObject({
      title: "Style guide",
      link: "https://example.com/guía",
      emoji: ":memo:",
      last_updated_by_user_id: bob.id,
    })
    expect(edited.bookmark.date_updated).toBeGreaterThan(0)
    // An empty emoji clears it; a new link replaces it.
    const cleared = await ok<{ bookmark: Bookmark }>(
      "bookmarks.edit",
      { channel_id: w.general, bookmark_id: first.bookmark.id, emoji: "", link: "https://example.com/style" },
      bob.token,
    )
    expect(cleared.bookmark).toMatchObject({ emoji: "", link: "https://example.com/style", title: "Style guide" })

    await ok("bookmarks.remove", { channel_id: w.general, bookmark_id: first.bookmark.id }, w.owner.token)
    await expectError(
      "bookmarks.remove",
      { channel_id: w.general, bookmark_id: first.bookmark.id },
      w.owner.token,
      "not_found",
    )
    await expectError(
      "bookmarks.edit",
      { channel_id: w.general, bookmark_id: first.bookmark.id, title: "x" },
      w.owner.token,
      "not_found",
    )
    const left = await ok<{ bookmarks: Bookmark[] }>("bookmarks.list", { channel_id: w.general }, bob.token)
    expect(left.bookmarks).toHaveLength(2)
  })

  it("answers Slack's errors and takes only http(s) links", async () => {
    const w = await workspace()
    const bob = await w.addUser("bob")
    const expectAdd = (args: Record<string, unknown>, error: string, token = w.owner.token) =>
      expectError(
        "bookmarks.add",
        { channel_id: w.general, type: "link", title: "t", link: "https://example.com", ...args },
        token,
        error,
      )
    await expectAdd({ type: "folder" }, "invalid_bookmark_type")
    await expectAdd({ link: "javascript:alert(1)" }, "invalid_link")
    await expectAdd({ link: "file:///etc/passwd" }, "invalid_link")
    await expectAdd({ link: "not a url" }, "invalid_link")
    await expectAdd({ link: `https://example.com/${"x".repeat(2100)}` }, "invalid_link")
    await expectAdd({ link: undefined }, "invalid_link")
    await expectAdd({ title: "   " }, "invalid_arguments")
    await expectAdd({ title: "x".repeat(300) }, "invalid_arguments")
    await expectAdd({ emoji: "not an emoji" }, "invalid_emoji")
    await expectAdd({ channel_id: "C0NOPE" }, "channel_not_found")
    await expectError("bookmarks.remove", { channel_id: w.general }, w.owner.token, "not_found")
    // An edit to an empty title or link is refused, not ignored.
    const { bookmark } = await ok<{ bookmark: Bookmark }>(
      "bookmarks.add",
      { channel_id: w.general, type: "link", title: "Kept", link: "https://example.com/kept" },
      w.owner.token,
    )
    const edit = { channel_id: w.general, bookmark_id: bookmark.id }
    await expectError("bookmarks.edit", { ...edit, title: "" }, w.owner.token, "invalid_arguments")
    await expectError("bookmarks.edit", { ...edit, link: "" }, w.owner.token, "invalid_link")
    const kept = await ok<{ bookmarks: Bookmark[] }>("bookmarks.list", { channel_id: w.general }, w.owner.token)
    expect(kept.bookmarks).toMatchObject([{ title: "Kept", link: "https://example.com/kept" }])

    // A public channel bob isn't in: he reads its bookmarks but doesn't change them.
    const { channel } = await ok<{ channel: { id: string } }>("conversations.create", { name: "docs" }, w.owner.token)
    await ok(
      "bookmarks.add",
      { channel_id: channel.id, type: "link", title: "Wiki", link: "https://example.com/wiki" },
      w.owner.token,
    )
    expect(
      (await ok<{ bookmarks: Bookmark[] }>("bookmarks.list", { channel_id: channel.id }, bob.token)).bookmarks,
    ).toHaveLength(1)
    await expectAdd({ channel_id: channel.id }, "not_in_channel", bob.token)

    const secret = await ok<{ channel: { id: string } }>(
      "conversations.create",
      { name: "secret", is_private: true },
      w.owner.token,
    )
    await expectError("bookmarks.list", { channel_id: secret.channel.id }, bob.token, "channel_not_found")

    await ok("conversations.archive", { channel: channel.id }, w.owner.token)
    await expectAdd({ channel_id: channel.id }, "is_archived")
  })

  it("caps bookmarks per conversation", async () => {
    const w = await workspace()
    await env.DB.prepare(
      `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 100)
       INSERT INTO bookmarks (id, team_id, channel_id, title, link, rank, created_by, updated_by, date_created)
       SELECT 'Bk' || i, ?, ?, 't', 'https://example.com', printf('%010d', i), ?, ?, 1 FROM n`,
    )
      .bind(w.teamId, w.general, w.owner.id, w.owner.id)
      .run()
    await expectError(
      "bookmarks.add",
      { channel_id: w.general, type: "link", title: "t", link: "https://example.com" },
      w.owner.token,
      "too_many_bookmarks",
    )
  })

  it("sends bookmark_added, bookmark_changed and bookmark_removed to the members", async () => {
    const w = await workspace()
    const bob = await w.addUser("bob")
    const rtm = await connect((await ok<{ url: string }>("rtm.connect", {}, bob.token)).url)
    await rtm.next((f) => f.type === "hello")
    const { bookmark } = await ok<{ bookmark: Bookmark }>(
      "bookmarks.add",
      { channel_id: w.general, type: "link", title: "Agenda", link: "https://example.com/agenda" },
      w.owner.token,
    )
    expect(await rtm.next((f) => f.type === "bookmark_added")).toMatchObject({
      channel_id: w.general,
      bookmark: { id: bookmark.id, title: "Agenda" },
    })
    await ok("bookmarks.edit", { channel_id: w.general, bookmark_id: bookmark.id, title: "Ordre du jour" }, bob.token)
    expect(await rtm.next((f) => f.type === "bookmark_changed")).toMatchObject({
      bookmark: { id: bookmark.id, title: "Ordre du jour" },
    })
    await ok("bookmarks.remove", { channel_id: w.general, bookmark_id: bookmark.id }, bob.token)
    expect(await rtm.next((f) => f.type === "bookmark_removed")).toMatchObject({
      channel_id: w.general,
      bookmark: { id: bookmark.id },
    })
    rtm.close()
  })

  it("records the app when a bot adds one, and wants the bookmarks scopes", async () => {
    const w = await workspace()
    const app = await w.addApp("Linker")
    await ok("conversations.join", { channel: w.general }, app.botToken)
    const { bookmark } = await ok<{ bookmark: Bookmark }>(
      "bookmarks.add",
      { channel_id: w.general, type: "link", title: "Runbook", link: "https://example.com/runbook" },
      app.botToken,
    )
    expect(bookmark.app_id).toBe(app.id)

    const reader = await issueToken(env, {
      teamId: w.teamId,
      kind: "user",
      userId: w.owner.id,
      scopes: ["read"],
      label: "reader",
    })
    await ok("bookmarks.list", { channel_id: w.general }, reader)
    await expectError(
      "bookmarks.add",
      { channel_id: w.general, type: "link", title: "t", link: "https://example.com" },
      reader,
      "missing_scope",
    )
  })
})
