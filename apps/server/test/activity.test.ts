import { env } from "cloudflare:workers"
import { describe, expect, it } from "vitest"
import { issueToken } from "../src/api/auth"
import { PRESETS } from "../src/api/scopes"
import { mentionsOf } from "../src/activity"
import { call, connect, expectError, ok, workspace } from "./helpers"

interface Item {
  id: string
  type: string
  channel: string
  ts: string
  thread_ts?: string
  actor?: string
  reaction?: string
  is_read: boolean
  notify: boolean
  message?: { text: string; ts: string; reactions?: unknown[] }
  permalink: string
}

interface Listed {
  items: Item[]
  unread: Record<string, number>
  response_metadata: { next_cursor: string }
}

const inbox = (token: string, args: Record<string, unknown> = {}) => ok<Listed>("campflare.activity.list", args, token)

const post = async (token: string, where: string, text: string, extra: Record<string, unknown> = {}) =>
  (await ok<{ ts: string; channel: string }>("chat.postMessage", { channel: where, text, ...extra }, token)).ts

async function channel(token: string, name: string, isPrivate = false) {
  return (await ok<{ channel: { id: string } }>("conversations.create", { name, is_private: isPrivate }, token)).channel
    .id
}

async function dmWith(token: string, users: string) {
  return (await ok<{ channel: { id: string } }>("conversations.open", { users }, token)).channel.id
}

describe("mentionsOf", () => {
  it("finds people and the broadcasts in text", () => {
    expect(mentionsOf("hola <@U1> y <@U2|bea> y <@U1>")).toEqual({ users: ["U1", "U2"], everyone: false })
    expect(mentionsOf("<!here|here> 你好")).toEqual({ users: [], everyone: true })
    expect(mentionsOf("<!channel>").everyone).toBe(true)
    expect(mentionsOf("<!everyone>").everyone).toBe(true)
    expect(mentionsOf("<!subteam^S1> <#C1>")).toEqual({ users: [], everyone: false })
  })
})

describe("activity items", () => {
  it("records a mention for the person named, with the message, and nothing for the author", async () => {
    const w = await workspace()
    const bob = await w.addUser("bob")
    const ts = await post(w.owner.token, w.general, `<@${bob.id}> ¿revisas esto? 確認してください`)
    const listed = await inbox(bob.token)
    expect(listed.items).toEqual([
      expect.objectContaining({
        type: "mention",
        channel: w.general,
        ts,
        actor: w.owner.id,
        is_read: false,
        notify: true,
        message: expect.objectContaining({ text: expect.stringContaining("確認"), ts }),
        permalink: expect.stringContaining(`/archives/${w.general}/p`),
      }),
    ])
    expect(listed.unread).toEqual({ total: 1, mention: 1, dm: 0, thread_reply: 0, reaction: 0 })
    expect((await inbox(w.owner.token)).items).toEqual([])
  })

  it("reaches only members: a mention of someone outside the conversation records nothing", async () => {
    const w = await workspace()
    const bob = await w.addUser("bob")
    const room = await channel(w.owner.token, "salle", true)
    await post(w.owner.token, room, `<@${bob.id}> 비밀`)
    expect((await inbox(bob.token)).items).toEqual([])
  })

  it("records @here, @channel and @everyone for every member but the author", async () => {
    const w = await workspace()
    const bob = await w.addUser("bob")
    const carol = await w.addUser("carol")
    await post(bob.token, w.general, "<!here> Kaffee? 咖啡？")
    expect((await inbox(carol.token)).items.map((i) => i.type)).toEqual(["mention"])
    expect((await inbox(w.owner.token)).items.map((i) => i.type)).toEqual(["mention"])
    expect((await inbox(bob.token)).items).toEqual([])
  })

  it("records a DM for the other people in an im or mpim, a mention when it names them", async () => {
    const w = await workspace()
    const bob = await w.addUser("bob")
    const carol = await w.addUser("carol")
    const im = await dmWith(w.owner.token, bob.id)
    await post(w.owner.token, im, "¿Tienes un minuto?")
    const group = await dmWith(w.owner.token, `${bob.id},${carol.id}`)
    await post(w.owner.token, group, `<@${carol.id}> 잠깐 시간 있어?`)
    expect((await inbox(bob.token)).items.map((i) => [i.type, i.channel])).toEqual([
      ["dm", group],
      ["dm", im],
    ])
    expect((await inbox(carol.token)).items.map((i) => i.type)).toEqual(["mention"])
    expect((await inbox(w.owner.token)).items).toEqual([])
  })

  it("records thread replies for the thread's author and those who replied, not bystanders", async () => {
    const w = await workspace()
    const bob = await w.addUser("bob")
    const carol = await w.addUser("carol")
    const dave = await w.addUser("dave")
    const root = await post(w.owner.token, w.general, "Planificación 计划")
    await post(bob.token, w.general, "d'accord", { thread_ts: root })
    await post(carol.token, w.general, "賛成", { thread_ts: root })
    const owner = await inbox(w.owner.token)
    expect(owner.items.map((i) => [i.type, i.actor, i.thread_ts])).toEqual([
      ["thread_reply", carol.id, root],
      ["thread_reply", bob.id, root],
    ])
    expect((await inbox(bob.token)).items.map((i) => [i.type, i.actor])).toEqual([["thread_reply", carol.id]])
    expect((await inbox(carol.token)).items).toEqual([])
    expect((await inbox(dave.token)).items).toEqual([])
  })

  it("records a reaction for the message's author, and forgets it when the reaction goes", async () => {
    const w = await workspace()
    const bob = await w.addUser("bob")
    const ts = await post(w.owner.token, w.general, "Fertig! 完成了")
    await ok("reactions.add", { channel: w.general, timestamp: ts, name: "tada" }, bob.token)
    await ok("reactions.add", { channel: w.general, timestamp: ts, name: "eyes" }, w.owner.token)
    const listed = await inbox(w.owner.token)
    expect(listed.items).toEqual([expect.objectContaining({ type: "reaction", reaction: "tada", actor: bob.id, ts })])
    expect(listed.items[0]!.message!.reactions).toHaveLength(2)
    await ok("reactions.remove", { channel: w.general, timestamp: ts, name: "tada" }, bob.token)
    expect((await inbox(w.owner.token)).items).toEqual([])
  })

  it("forgets a deleted message's items, and a tombstoned thread head's", async () => {
    const w = await workspace()
    const bob = await w.addUser("bob")
    const ts = await post(w.owner.token, w.general, `<@${bob.id}> oups`)
    await ok("chat.delete", { channel: w.general, ts }, w.owner.token)
    const head = await post(bob.token, w.general, "ルート")
    await ok("reactions.add", { channel: w.general, timestamp: head, name: "ok" }, w.owner.token)
    await post(w.owner.token, w.general, "réponse", { thread_ts: head })
    expect((await inbox(bob.token)).items.map((i) => i.type)).toEqual(["thread_reply", "reaction"])
    await ok("chat.delete", { channel: w.general, ts: head }, bob.token)
    // The reply's item stays: the reply is still there.
    expect((await inbox(bob.token)).items.map((i) => i.type)).toEqual(["thread_reply"])
  })

  it("hides the items of a conversation the person left, and shows them again on return", async () => {
    const w = await workspace()
    const bob = await w.addUser("bob")
    const room = await channel(w.owner.token, "sala")
    await ok("conversations.join", { channel: room }, bob.token)
    await post(w.owner.token, room, `<@${bob.id}> ¡hola! 안녕`)
    await ok("conversations.leave", { channel: room }, bob.token)
    const listed = await inbox(bob.token)
    expect(listed.items).toEqual([])
    expect(listed.unread.total).toBe(0)
    await ok("conversations.join", { channel: room }, bob.token)
    expect((await inbox(bob.token)).items).toHaveLength(1)
  })

  it("counts bots both ways: a bot's mention, and a bot's own inbox", async () => {
    const w = await workspace()
    const bob = await w.addUser("bob")
    const app = await w.addApp("ayudante")
    await ok("conversations.join", { channel: w.general }, app.botToken)
    await post(app.botToken, w.general, `<@${bob.id}> listo, 完了`)
    expect((await inbox(bob.token)).items).toEqual([expect.objectContaining({ type: "mention", actor: app.botUserId })])
    await post(bob.token, w.general, `<@${app.botUserId}> merci`)
    expect((await inbox(app.botToken)).items).toEqual([expect.objectContaining({ type: "mention", actor: bob.id })])
  })

  it("records nothing for joins, edits or plain channel messages", async () => {
    const w = await workspace()
    const bob = await w.addUser("bob")
    const room = await channel(w.owner.token, "nada")
    await ok("conversations.join", { channel: room }, bob.token)
    const ts = await post(w.owner.token, room, "Guten Morgen 早上好")
    await ok("chat.update", { channel: room, ts, text: `<@${bob.id}> Guten Morgen` }, w.owner.token)
    expect((await inbox(bob.token)).items).toEqual([])
    expect((await inbox(w.owner.token)).items).toEqual([])
  })
})

describe("the activity table", () => {
  it("holds one item per message per person even when nobody is known to have done it", async () => {
    const insert = () =>
      env.DB.prepare(
        `INSERT INTO activity (team_id, user_id, kind, channel_id, ts, created) VALUES ('T1', 'U1', 'dm', 'D1', '1.000001', 1)`,
      ).run()
    await insert()
    await expect(insert()).rejects.toThrow(/UNIQUE/)
  })
})

describe("listing", () => {
  it("pages newest first, filters by type and by unread", async () => {
    const w = await workspace()
    const bob = await w.addUser("bob")
    const im = await dmWith(w.owner.token, bob.id)
    for (const text of ["uno", "二", "trois"]) await post(w.owner.token, w.general, `<@${bob.id}> ${text}`)
    for (const text of ["vier", "다섯"]) await post(w.owner.token, im, text)
    const first = await inbox(bob.token, { limit: 2 })
    expect(first.items.map((i) => i.message!.text)).toEqual(["vier", "다섯"].toReversed())
    expect(first.unread).toMatchObject({ total: 5, mention: 3, dm: 2 })
    const second = await inbox(bob.token, { limit: 2, cursor: first.response_metadata.next_cursor })
    const third = await inbox(bob.token, { limit: 2, cursor: second.response_metadata.next_cursor })
    expect([...second.items, ...third.items].map((i) => i.type)).toEqual(["mention", "mention", "mention"])
    expect(third.response_metadata.next_cursor).toBe("")

    const mentions = await inbox(bob.token, { types: "mention" })
    expect(mentions.items).toHaveLength(3)
    await ok("campflare.activity.mark", { ids: mentions.items[0]!.id }, bob.token)
    expect((await inbox(bob.token, { unread_only: true, types: "mention" })).items).toHaveLength(2)
    expect((await inbox(bob.token, { types: "mention,dm" })).items).toHaveLength(5)

    await expectError("campflare.activity.list", { types: "everything" }, bob.token, "invalid_arguments")
    await expectError("campflare.activity.list", { cursor: "nonsense" }, bob.token, "invalid_cursor")
  })

  it("lists only the conversation types the token may read the history of", async () => {
    const w = await workspace()
    const bob = await w.addUser("bob")
    const im = await dmWith(w.owner.token, bob.id)
    await post(w.owner.token, im, "privé")
    await post(w.owner.token, w.general, `<@${bob.id}> público`)
    const narrow = await issueToken(env, {
      teamId: w.teamId,
      kind: "user",
      userId: bob.id,
      scopes: ["activity:read", "channels:history"],
      label: "agente",
    })
    const listed = await inbox(narrow)
    expect(listed.items.map((i) => i.type)).toEqual(["mention"])
    expect(listed.unread.total).toBe(1)
  })
})

describe("marking read", () => {
  it("marks by ids, up to an item, or all, and answers the counts", async () => {
    const w = await workspace()
    const bob = await w.addUser("bob")
    for (const text of ["a", "b", "c", "d"]) await post(w.owner.token, w.general, `<@${bob.id}> ${text}`)
    const ids = (await inbox(bob.token)).items.map((i) => i.id)
    expect(await ok("campflare.activity.mark", { ids: ids[0] }, bob.token)).toMatchObject({
      marked: 1,
      unread: { total: 3, mention: 3 },
    })
    expect(await ok("campflare.activity.mark", { up_to: ids[2] }, bob.token)).toMatchObject({
      marked: 2,
      unread: { total: 1 },
    })
    expect(await ok("campflare.activity.mark", { all: true }, bob.token)).toMatchObject({
      marked: 1,
      unread: { total: 0 },
    })
    expect((await inbox(bob.token)).items.every((i) => i.is_read)).toBe(true)
    // Someone else's ids are not theirs to mark.
    expect(await ok("campflare.activity.mark", { ids: ids.join(",") }, w.owner.token)).toMatchObject({ marked: 0 })
    await expectError("campflare.activity.mark", {}, bob.token, "invalid_arguments")
    await expectError("campflare.activity.mark", { all: true, up_to: ids[0] }, bob.token, "invalid_arguments")
    await expectError("campflare.activity.mark", { ids: "x1" }, bob.token, "invalid_arguments")
  })
})

describe("marking what can't be listed", () => {
  it("leaves items the token can't list unread: other types, conversations left", async () => {
    const w = await workspace()
    const bob = await w.addUser("bob")
    const im = await dmWith(w.owner.token, bob.id)
    await post(w.owner.token, im, "secreto 秘密")
    const room = await channel(w.owner.token, "salida")
    await ok("conversations.join", { channel: room }, bob.token)
    await post(w.owner.token, room, `<@${bob.id}> adiós 再见`)
    await ok("conversations.leave", { channel: room }, bob.token)
    await post(w.owner.token, w.general, `<@${bob.id}> público`)
    const narrow = await issueToken(env, {
      teamId: w.teamId,
      kind: "user",
      userId: bob.id,
      scopes: ["activity:read", "activity:write", "channels:history"],
      label: "agente",
    })
    expect(await ok("campflare.activity.mark", { all: true }, narrow)).toMatchObject({
      marked: 1,
      unread: { total: 0 },
    })
    // The DM is still unread for a token that can read it; the channel left stays hidden and unread.
    expect((await inbox(bob.token)).unread).toMatchObject({ total: 1, dm: 1 })
    await ok("conversations.join", { channel: room }, bob.token)
    expect(await ok("campflare.activity.mark", { all: true }, bob.token)).toMatchObject({ marked: 2 })
  })
})

describe("live", () => {
  it("sends activity_added, activity_marked and activity_removed to the recipient only", async () => {
    const w = await workspace()
    const bob = await w.addUser("bob")
    const link = await connect((await ok<{ url: string }>("rtm.connect", {}, bob.token)).url)
    const owners = await connect((await ok<{ url: string }>("rtm.connect", {}, w.owner.token)).url)
    await link.next((f) => f.type === "hello")
    await owners.next((f) => f.type === "hello")
    const ts = await post(w.owner.token, w.general, `<@${bob.id}> écoute 听`)
    const added = await link.next((f) => f.type === "activity_added")
    expect(added.item).toMatchObject({ type: "mention", ts, notify: true, message: { ts } })
    const id = (added.item as Item).id

    await ok("campflare.activity.mark", { ids: id }, bob.token)
    expect(await link.next((f) => f.type === "activity_marked")).toMatchObject({ ids: [id], unread: { total: 0 } })

    const mine = await post(bob.token, w.general, "Meine Nachricht")
    await ok("reactions.add", { channel: w.general, timestamp: mine, name: "heart" }, w.owner.token)
    const reaction = await link.next((f) => f.type === "activity_added")
    expect(reaction.item).toMatchObject({ type: "reaction", reaction: "heart", message: { ts: mine } })
    await ok("reactions.remove", { channel: w.general, timestamp: mine, name: "heart" }, w.owner.token)
    expect(await link.next((f) => f.type === "activity_removed")).toMatchObject({
      ids: [(reaction.item as Item).id],
    })

    await ok("chat.delete", { channel: w.general, ts }, w.owner.token)
    expect(await link.next((f) => f.type === "activity_removed")).toMatchObject({ ids: [id] })
    expect(owners.frames.filter((f) => String(f.type).startsWith("activity_"))).toEqual([])
    link.close()
    owners.close()
  })
})

describe("notification preferences", () => {
  it("sets levels per conversation and a default, which decide notify", async () => {
    const w = await workspace()
    const bob = await w.addUser("bob")
    const quiet = await channel(w.owner.token, "tranquilo")
    const muted = await channel(w.owner.token, "silencio")
    for (const c of [quiet, muted]) await ok("conversations.join", { channel: c }, bob.token)

    expect(await ok("campflare.prefs.get", {}, bob.token)).toMatchObject({
      prefs: { notifications: { default: "all", conversations: {} } },
    })
    await ok("campflare.prefs.set", { channel: quiet, level: "mentions" }, bob.token)
    const set = await ok("campflare.prefs.set", { channel: "#silencio", level: "none" }, bob.token)
    expect(set).toMatchObject({
      prefs: { notifications: { default: "all", conversations: { [quiet]: "mentions", [muted]: "none" } } },
    })

    // mentions: a mention notifies, a thread reply is recorded quietly.
    const root = await post(bob.token, quiet, "スレッド")
    await post(w.owner.token, quiet, "respuesta", { thread_ts: root })
    await post(w.owner.token, quiet, `<@${bob.id}> mira`)
    // none: recorded, never notifies.
    await post(w.owner.token, muted, `<@${bob.id}> 조용히`)
    const listed = await inbox(bob.token)
    expect(listed.items.map((i) => [i.channel, i.type, i.notify])).toEqual([
      [muted, "mention", false],
      [quiet, "mention", true],
      [quiet, "thread_reply", false],
    ])

    // The default applies where no conversation level is set; "default" clears one.
    await ok("campflare.prefs.set", { level: "none" }, bob.token)
    await ok("campflare.prefs.set", { channel: muted, level: "default" }, bob.token)
    expect(await ok("campflare.prefs.get", {}, bob.token)).toMatchObject({
      prefs: { notifications: { default: "none", conversations: { [quiet]: "mentions" } } },
    })
    await post(w.owner.token, muted, `<@${bob.id}> ¿otra vez?`)
    await post(w.owner.token, quiet, `<@${bob.id}> encore`)
    const after = await inbox(bob.token, { limit: 2 })
    expect(after.items.map((i) => [i.channel, i.notify])).toEqual([
      [quiet, true],
      [muted, false],
    ])

    await expectError("campflare.prefs.set", { level: "loud" }, bob.token, "invalid_arguments")
    await expectError("campflare.prefs.set", {}, bob.token, "invalid_arguments")
    const secret = await channel(w.owner.token, "secreto", true)
    await expectError("campflare.prefs.set", { channel: secret, level: "none" }, bob.token, "channel_not_found")
  })

  it("tells the person's clients when prefs change", async () => {
    const w = await workspace()
    const link = await connect((await ok<{ url: string }>("rtm.connect", {}, w.owner.token)).url)
    await link.next((f) => f.type === "hello")
    await ok("campflare.prefs.set", { level: "mentions" }, w.owner.token)
    expect(await link.next((f) => f.type === "prefs_changed")).toMatchObject({
      prefs: { notifications: { default: "mentions" } },
    })
    link.close()
  })

  it("never notifies while the person is snoozed", async () => {
    const w = await workspace()
    const bob = await w.addUser("bob")
    await ok("dnd.setSnooze", { num_minutes: 30 }, bob.token)
    await post(w.owner.token, w.general, `<@${bob.id}> später 稍后`)
    expect((await inbox(bob.token)).items.map((i) => i.notify)).toEqual([false])
    await ok("dnd.endSnooze", {}, bob.token)
    await post(w.owner.token, w.general, `<@${bob.id}> jetzt 现在`)
    expect((await inbox(bob.token)).items.map((i) => i.notify)).toEqual([true, false])
  })
})

describe("scopes", () => {
  it("wants activity:* and prefs:*, which the presets carry", async () => {
    const w = await workspace()
    const token = await issueToken(env, {
      teamId: w.teamId,
      kind: "user",
      userId: w.owner.id,
      scopes: ["channels:history"],
      label: "estrecho",
    })
    for (const [name, args, needed] of [
      ["campflare.activity.list", {}, "activity:read"],
      ["campflare.activity.mark", { all: true }, "activity:write"],
      ["campflare.prefs.get", {}, "prefs:read"],
      ["campflare.prefs.set", { level: "all" }, "prefs:write"],
    ] as const) {
      expect(await call(name, args, token)).toMatchObject({ error: "missing_scope", needed })
    }
    expect(PRESETS.read).toEqual(expect.arrayContaining(["activity:read", "prefs:read"]))
    expect(PRESETS.read).not.toContain("activity:write")
    expect(PRESETS.write).toEqual(expect.arrayContaining(["activity:write", "prefs:write"]))
  })
})
