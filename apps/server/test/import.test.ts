import { SELF } from "cloudflare:test"
import { env } from "cloudflare:workers"
import { describe, expect, it } from "vitest"
import { LIMITS, UNDO_WINDOW_SECONDS } from "../src/import/job"
import { groups } from "../src/import/messages"
import { candidates, channelNameFrom, handleFrom, rewriteText, withoutFileLine } from "../src/import/text"
import { call, expectError, ok, settle, workspace, type Workspace } from "./helpers"

// Importing a Slack export (docs/import.md): a synthetic export, sent as the CLI sends it.

type Job = {
  id: string
  state: string
  options: { merge_into_existing: boolean; files: string }
  counts: Record<string, number | string[]>
}
type Message = {
  ts: string
  user?: string
  username?: string
  subtype?: string
  text: string
  thread_ts?: string
  parent_user_id?: string
  reply_count?: number
  reply_users?: string[]
  edited?: { user: string; ts: string }
  reactions?: { name: string; users: string[]; count: number }[]
  pinned_to?: string[]
  files?: { id: string; name: string }[]
}
type Poll = { events: unknown[]; cursor: string }

let n = 0
const teamName = () => `imp${++n}${Date.now().toString(36)}`

/** A Slack export's users.json, for a workspace whose owner is owner@<name>.test and with ana@<name>.test. */
function exportUsers(name: string) {
  return [
    { id: "U01", name: "olive", real_name: "Olive Owner", profile: { email: `OWNER@${name}.test` } },
    { id: "U02", name: "ana", real_name: "Ana", profile: { email: `ana@${name}.test` } },
    { id: "U03", name: "wang.fang", real_name: "王芳", tz: "Asia/Shanghai", profile: { title: "设计师" } },
    { id: "U04", name: "jose", real_name: "José Álvarez", profile: { email: "jose@elsewhere.test" } },
    { id: "U05", name: "minjun", real_name: "김민준", deleted: true, profile: { display_name: "민준" } },
    { id: "U06", name: "françoise", real_name: "Françoise Dupont", profile: { email: "f@elsewhere.test" } },
    // Another "ana", by name only: her handle is taken here.
    { id: "U07", name: "ana", real_name: "Ana Müller", profile: { email: "ana.mueller@elsewhere.test" } },
    { id: "B01", name: "deploybot", real_name: "Deploy Bot", is_bot: true, profile: {} },
    { id: "USLACKBOT", name: "slackbot", real_name: "Slackbot", is_bot: true, profile: {} },
  ]
}

const exportConversations = [
  {
    id: "C01",
    type: "channel",
    name: "general",
    is_general: true,
    created: 1_600_000_000,
    creator: "U01",
    members: ["U01", "U02", "U03", "U04", "U05", "U06"],
    topic: { value: "Tout le monde · みんな", creator: "U01", last_set: 1_600_000_001 },
    purpose: { value: "Company-wide", creator: "U01", last_set: 1_600_000_002 },
  },
  { id: "C02", type: "channel", name: "design", creator: "U03", members: ["U01", "U03"], is_archived: true },
  { id: "C03", type: "channel", name: "東京", creator: "U03", members: ["U03", "U04"] },
  { id: "G01", type: "group", name: "secret-plans", creator: "U01", members: ["U01", "U02", "U03"] },
  { id: "D01", type: "im", members: ["U01", "U03"] },
  { id: "G02", type: "mpim", name: "mpdm-olive--ana--jose-1", members: ["U01", "U02", "U04"] },
  // Someone not in users.json: there's no one to give it to.
  { id: "D02", type: "im", members: ["U01", "U99"] },
]

const HEAD = "1700000100.000200"
/** #general's messages: replies in the first chunk, their head in the second. */
const chunk1 = [
  { ts: "1700000200.000300", user: "U04", text: "Entendido, señor. ¡Vamos!", thread_ts: HEAD, parent_user_id: "U03" },
  { ts: "1700000300.000400", user: "U05", text: "좋아요! 회의 시작합니다", thread_ts: HEAD, parent_user_id: "U03" },
  {
    ts: "1700000000.000100",
    user: "U01",
    text: "Hello <@U02>, welcome! ¿Qué tal, <@U04|jose>? Ça va très bien.",
    reactions: [{ name: "tada", users: ["U02", "U03", "U99"], count: 3 }],
    pinned_to: ["C01"],
  },
]
const chunk2 = [
  {
    ts: HEAD,
    user: "U03",
    text: "今日は会議があります <#C02|design>, see <#C77|elsewhere>",
    thread_ts: HEAD,
    reply_count: 2,
    blocks: [{ type: "rich_text", elements: [] }],
  },
  {
    ts: "1700000400.000500",
    user: "U06",
    text: "Prêt à démarrer, Jürgen?",
    edited: { user: "U06", ts: "1700000450.000000" },
    pinned_to: ["C01"],
    pinned_info: { pinned_by: "U02", pinned_ts: 1_700_000_460 },
  },
  {
    ts: "1700000500.000600",
    subtype: "bot_message",
    bot_id: "B999",
    username: "CI",
    text: "Build passed ✅",
    attachments: [{ text: "main · 3 minutes" }],
  },
  { ts: "1700000600.000700", user: "U05", subtype: "channel_join", text: "<@U05> has joined the channel" },
  {
    ts: "1700000700.000800",
    user: "U02",
    text: "Here is the plan",
    files: [
      { id: "F01", name: "plan.pdf", url_private_download: "https://files.example.test/F01/plan.pdf" },
      { id: "F02", name: "old.png", mode: "hidden_by_limit" },
    ],
  },
  // A reply whose head isn't in the export.
  { ts: "1700000800.000900", user: "U02", text: "Respuesta huérfana", thread_ts: "1699999999.000001" },
  { ts: "1700000900.001000", user: "U99", user_profile: { real_name: "Ghost" }, text: "<@U99|ghost> says hi" },
  { ts: "1700001000.001100", user: "USLACKBOT", text: "Reminder: 締め切り" },
  {
    ts: "1700001100.001200",
    subtype: "bot_message",
    text: "",
    blocks: [{ type: "section", text: { type: "mrkdwn", text: "Deployed" } }],
  },
]

/** A workspace with ana in it, and #design taken. */
async function setUp(): Promise<{ w: Workspace; ana: { id: string; token: string }; design: string; name: string }> {
  const name = teamName()
  const w = await workspace(name)
  const ana = await w.addUser("ana")
  const { channel } = await ok<{ channel: { id: string } }>("conversations.create", { name: "design" }, w.owner.token)
  return { w, ana, design: channel.id, name }
}

async function start(token: string, args: Record<string, unknown> = {}) {
  return (await ok<{ job: Job; resumed: boolean }>("campflare.import.start", args, token)).job
}

/** Users and conversations of the export, mapped. */
async function prepare(token: string, name: string, job: string) {
  const users = await ok<{ users: { source_id: string; user_id: string; action: string }[] }>(
    "campflare.import.users",
    { job, users: exportUsers(name) },
    token,
  )
  const conversations = await ok<{
    conversations: { source_id: string; conversation_id: string | null; action: string; name?: string }[]
  }>("campflare.import.conversations", { job, conversations: exportConversations }, token)
  return {
    user: new Map(users.users.map((u) => [u.source_id, u])),
    conversation: new Map(conversations.conversations.map((c) => [c.source_id, c])),
  }
}

const messages = (token: string, job: string, conversation: string, list: unknown[], extra = {}) =>
  ok<{ channel: string; imported: number; skipped: number; files_needed: { id: string; ts: string }[] }>(
    "campflare.import.messages",
    { job, conversation, messages: list, ...extra },
    token,
  )

async function history(token: string, channel: string) {
  return (await ok<{ messages: Message[] }>("conversations.history", { channel, limit: 100 }, token)).messages
}

const status = async (token: string, job: string) =>
  (await ok<{ job: Job }>("campflare.import.status", { job }, token)).job

async function finish(token: string, job: string) {
  for (;;) {
    const res = await ok<{ done: boolean; job: Job }>("campflare.import.finish", { job }, token)
    if (res.done) return res.job
  }
}

async function undo(token: string, job: string) {
  const removed: Record<string, number> = {}
  for (;;) {
    const res = await ok<{ done: boolean; removed: Record<string, number>; job: Job }>(
      "campflare.import.undo",
      { job },
      token,
    )
    for (const [k, v] of Object.entries(res.removed)) removed[k] = (removed[k] ?? 0) + v
    if (res.done) return { removed, job: res.job }
  }
}

describe("campflare.import", () => {
  it("imports people, conversations and messages, mapped, and nothing announces it", async () => {
    const { w, ana, design, name } = await setUp()
    const before = await ok<Poll>("campflare.events.poll", {}, ana.token)
    const ownerBefore = await ok<Poll>("campflare.events.poll", {}, w.owner.token)
    const job = await start(w.owner.token, { fingerprint: `fp-${name}`, source_name: "Acme export" })
    expect(job).toMatchObject({ state: "running", options: { merge_into_existing: false, files: "skip" } })

    const { user, conversation } = await prepare(w.owner.token, name, job.id)
    // By email, case aside; the rest are deactivated placeholders.
    expect(user.get("U01")).toMatchObject({ user_id: w.owner.id, action: "mapped" })
    expect(user.get("U02")).toMatchObject({ user_id: ana.id, action: "mapped" })
    expect(user.get("USLACKBOT")).toMatchObject({ user_id: "USLACKBOT", action: "mapped" })
    for (const id of ["U03", "U04", "U05", "U06", "U07", "B01"]) expect(user.get(id)!.action).toBe("created")
    const wang = user.get("U03")!.user_id
    const info = await ok<{ user: Record<string, unknown> & { profile: Record<string, unknown> } }>(
      "users.info",
      { user: wang },
      w.owner.token,
    )
    expect(info.user).toMatchObject({ name: "wang.fang", real_name: "王芳", deleted: true, tz: "Asia/Shanghai" })
    expect(info.user.profile.title).toBe("设计师")
    const handles = await Promise.all(
      ["U06", "U07", "B01"].map(async (id) => {
        const u = await ok<{ user: { name: string; is_bot: boolean } }>(
          "users.info",
          { user: user.get(id)!.user_id },
          w.owner.token,
        )
        return [u.user.name, u.user.is_bot]
      }),
    )
    expect(handles).toEqual([
      ["francoise", false],
      ["ana-imported", false],
      ["deploybot", true],
    ])
    // No placeholder has a token or an email.
    const tokens = await env.DB.prepare(
      "SELECT count(*) AS n FROM tokens t JOIN users u ON u.id = t.user_id WHERE u.import_job = ?",
    )
      .bind(job.id)
      .first<{ n: number }>()
    expect(tokens!.n).toBe(0)

    // #general and #design are taken: renamed. DMs go to the people; one with an unknown person is skipped.
    expect(conversation.get("C01")).toMatchObject({ action: "renamed", name: "general-imported" })
    expect(conversation.get("C02")).toMatchObject({ action: "renamed", name: "design-imported" })
    expect(conversation.get("C03")).toMatchObject({ action: "created", name: "東京" })
    expect(conversation.get("G01")!.action).toBe("created")
    expect(conversation.get("D01")!.action).toBe("created")
    expect(conversation.get("G02")!.action).toBe("created")
    expect(conversation.get("D02")).toMatchObject({ action: "skipped", conversation_id: null })
    const general = conversation.get("C01")!.conversation_id!
    expect(general).not.toBe(w.general)
    const designCopy = conversation.get("C02")!.conversation_id!
    expect(designCopy).not.toBe(design)

    const c = await ok<{ channel: Record<string, unknown> & { topic: { value: string } } }>(
      "conversations.info",
      { channel: general },
      w.owner.token,
    )
    expect(c.channel).toMatchObject({ name: "general-imported", is_general: false, created: 1_600_000_000 })
    expect(c.channel.topic.value).toBe("Tout le monde · みんな")
    const archived = await ok<{ channel: { is_archived: boolean } }>(
      "conversations.info",
      { channel: designCopy },
      w.owner.token,
    )
    expect(archived.channel.is_archived).toBe(true)
    const secret = await ok<{ channel: { is_private: boolean } }>(
      "conversations.info",
      { channel: conversation.get("G01")!.conversation_id },
      ana.token,
    )
    expect(secret.channel.is_private).toBe(true)
    const members = await ok<{ members: string[] }>("conversations.members", { channel: general }, w.owner.token)
    expect(members.members).toHaveLength(6)

    // Replies before their head.
    expect(await messages(w.owner.token, job.id, "C01", chunk1, { cursor: "2023-11-14.json" })).toMatchObject({
      imported: 3,
      skipped: 0,
    })
    const second = await messages(w.owner.token, job.id, "C01", chunk2, { cursor: "2023-11-15.json" })
    expect(second).toMatchObject({ imported: 9, skipped: 0, files_needed: [{ id: "F01", ts: "1700000700.000800" }] })

    const list = await history(w.owner.token, general)
    const at = (ts: string) => list.find((m) => m.ts === ts)!
    const first = at("1700000000.000100")
    expect(first.text).toBe(`Hello <@${ana.id}>, welcome! ¿Qué tal, <@${user.get("U04")!.user_id}>? Ça va très bien.`)
    expect(first.reactions).toEqual([{ name: "tada", users: expect.arrayContaining([ana.id, wang]), count: 2 }])
    expect(first.pinned_to).toEqual([general])
    expect(at(HEAD)).toMatchObject({
      text: `今日は会議があります <#${designCopy}>, see <#C77|elsewhere>`,
      thread_ts: HEAD,
      reply_count: 2,
      reply_users: [user.get("U04")!.user_id, user.get("U05")!.user_id],
    })
    expect(at(HEAD)).not.toHaveProperty("blocks")
    expect(at("1700000400.000500").edited).toEqual({ user: user.get("U06")!.user_id, ts: "1700000450.000000" })
    expect(at("1700000500.000600")).toMatchObject({ subtype: "bot_message", username: "CI", text: "Build passed ✅" })
    expect(at("1700000500.000600")).not.toHaveProperty("bot_id")
    expect(at("1700000500.000600")).not.toHaveProperty("user")
    expect(at("1700000600.000700")).toMatchObject({ subtype: "channel_join", user: user.get("U05")!.user_id })
    expect(at("1700000700.000800").text).toBe(
      "Here is the plan\n[file not imported: plan.pdf]\n[file not imported: old.png]",
    )
    expect(at("1700000900.001000")).toMatchObject({ username: "Ghost", text: "@ghost says hi" })
    expect(at("1700000900.001000")).not.toHaveProperty("user")
    expect(at("1700001000.001100").user).toBe("USLACKBOT")
    expect(at("1700001100.001200")).toHaveProperty("blocks")
    const replies = await ok<{ messages: Message[] }>(
      "conversations.replies",
      { channel: general, ts: HEAD },
      w.owner.token,
    )
    expect(replies.messages.map((m) => m.text)).toEqual([
      expect.stringContaining("今日は"),
      "Entendido, señor. ¡Vamos!",
      "좋아요! 회의 시작합니다",
    ])
    expect(replies.messages[1]!.parent_user_id).toBe(wang)
    const pins = await ok<{ items: { message: { ts: string } }[] }>("pins.list", { channel: general }, w.owner.token)
    expect(pins.items.map((p) => p.message.ts).toSorted()).toEqual(["1700000000.000100", "1700000400.000500"])
    const pinRow = await env.DB.prepare("SELECT pinned_by, pinned_at FROM messages WHERE channel_id = ? AND ts = ?")
      .bind(general, "1700000400.000500")
      .first()
    expect(pinRow).toEqual({ pinned_by: ana.id, pinned_at: 1_700_000_460 })

    // Search finds it, CJK substrings and accents aside.
    const found = await ok<{ messages: { matches: { ts: string }[] } }>(
      "search.messages",
      { query: "会議" },
      w.owner.token,
    )
    expect(found.messages.matches.map((m) => m.ts)).toContain(HEAD)
    const accent = await ok<{ messages: { matches: { ts: string }[] } }>(
      "search.messages",
      { query: "demarrer" },
      w.owner.token,
    )
    expect(accent.messages.matches.map((m) => m.ts)).toContain("1700000400.000500")

    // A DM and a group DM, with their people.
    await messages(w.owner.token, job.id, "D01", [{ ts: "1700002000.000001", user: "U03", text: "你好，奥利弗" }])
    await messages(w.owner.token, job.id, "G02", [{ ts: "1700002000.000002", user: "U04", text: "¡Hola a todos!" }])
    const dm = await history(w.owner.token, conversation.get("D01")!.conversation_id!)
    expect(dm.map((m) => m.text)).toEqual(["你好，奥利弗"])
    const anaDms = await ok<{ channels: { id: string }[] }>(
      "conversations.list",
      { types: "mpim,private_channel" },
      ana.token,
    )
    expect(anaDms.channels.map((ch) => ch.id)).toEqual(
      expect.arrayContaining([conversation.get("G02")!.conversation_id, conversation.get("G01")!.conversation_id]),
    )

    let counted = await status(w.owner.token, job.id)
    expect(counted.counts).toMatchObject({
      users_mapped: 3,
      users_created: 6,
      conversations_created: 4,
      conversations_renamed: 2,
      conversations_skipped: 1,
      messages: 14,
      messages_skipped: 0,
      reactions: 2,
      pins: 2,
      files: 1,
      files_attached: 0,
      files_skipped: 1,
      unmapped_users: ["U99"],
    })

    // Finishing: the orphan reply gets a tombstone head, history arrives read, threads have their people.
    const finished = await finish(w.owner.token, job.id)
    expect(finished.state).toBe("finished")
    const after = await history(w.owner.token, general)
    const tombstone = after.find((m) => m.ts === "1699999999.000001")!
    expect(tombstone).toMatchObject({ subtype: "tombstone", user: "USLACKBOT", reply_count: 1 })
    const orphan = await ok<{ messages: Message[] }>(
      "conversations.replies",
      { channel: general, ts: "1699999999.000001" },
      w.owner.token,
    )
    expect(orphan.messages[1]).toMatchObject({ text: "Respuesta huérfana", parent_user_id: "USLACKBOT" })
    const read = await ok<{ channel: { last_read: string; unread_count?: number } }>(
      "conversations.info",
      { channel: general },
      ana.token,
    )
    expect(read.channel.last_read).toBe("1700001100.001200")
    const participants = await env.DB.prepare(
      "SELECT user_id FROM thread_participants WHERE channel_id = ? AND thread_ts = ? ORDER BY user_id",
    )
      .bind(general, HEAD)
      .all<{ user_id: string }>()
    expect(participants.results.map((r) => r.user_id).toSorted()).toEqual(
      [wang, user.get("U04")!.user_id, user.get("U05")!.user_id].toSorted(),
    )

    // Writes after finishing are refused; status and list say where it is.
    await expectError(
      "campflare.import.messages",
      { job: job.id, conversation: "C01", messages: [] },
      w.owner.token,
      "import_not_running",
    )
    const listed = await ok<{ jobs: Job[] }>("campflare.import.list", {}, w.owner.token)
    expect(listed.jobs[0]).toMatchObject({ id: job.id, state: "finished" })
    counted = await status(w.owner.token, job.id)
    expect(counted.state).toBe("finished")

    // Nothing of it was announced: no events, no activity.
    await settle(100)
    expect((await ok<Poll>("campflare.events.poll", { cursor: before.cursor }, ana.token)).events).toEqual([])
    expect((await ok<Poll>("campflare.events.poll", { cursor: ownerBefore.cursor }, w.owner.token)).events).toEqual([])
    const inbox = await ok<{ items: unknown[] }>("campflare.activity.list", {}, ana.token)
    expect(inbox.items).toEqual([])
    const activity = await env.DB.prepare("SELECT count(*) AS n FROM activity WHERE channel_id = ?")
      .bind(general)
      .first<{ n: number }>()
    expect(activity!.n).toBe(0)

    // A later reply in an imported thread is an ordinary post, and reaches the thread's people.
    await ok("chat.postMessage", { channel: general, thread_ts: HEAD, text: "Follow-up" }, ana.token)
    const thread = await ok<{ messages: Message[] }>("conversations.replies", { channel: general, ts: HEAD }, ana.token)
    expect(thread.messages[0]!.reply_count).toBe(3)
  })

  it("is idempotent: the same chunk again changes nothing", async () => {
    const { w, name } = await setUp()
    const job = await start(w.owner.token)
    await prepare(w.owner.token, name, job.id)
    // Mapping again answers what is known.
    const again = await prepare(w.owner.token, name, job.id)
    expect([...again.user.values()].every((u) => u.action === "known")).toBe(true)
    expect(
      [...again.conversation.values()].filter((c) => c.action !== "skipped").every((c) => c.action === "known"),
    ).toBe(true)
    await messages(w.owner.token, job.id, "C01", [...chunk1, ...chunk2])
    const once = await status(w.owner.token, job.id)
    const repeated = await messages(w.owner.token, job.id, "C01", [...chunk2, ...chunk1])
    expect(repeated).toMatchObject({ imported: 12, skipped: 0 })
    const twice = await status(w.owner.token, job.id)
    expect(twice.counts).toEqual(once.counts)
    const general = repeated.channel
    const rows = await env.DB.prepare(
      "SELECT (SELECT count(*) FROM messages WHERE channel_id = ?1) AS messages, (SELECT count(*) FROM reactions WHERE channel_id = ?1) AS reactions",
    )
      .bind(general)
      .first()
    expect(rows).toEqual({ messages: 12, reactions: 2 })
    const head = (await history(w.owner.token, general)).find((m) => m.ts === HEAD)!
    expect(head.reply_count).toBe(2)
  })

  it("merges into existing conversations only when asked, and never touches their messages", async () => {
    const { w, design, name } = await setUp()
    const existing = await ok<{ ts: string }>("chat.postMessage", { channel: design, text: "Ours" }, w.owner.token)
    const job = await start(w.owner.token, { merge_into_existing: true })
    const { conversation } = await prepare(w.owner.token, name, job.id)
    expect(conversation.get("C01")).toMatchObject({ action: "merged", conversation_id: w.general })
    expect(conversation.get("C02")).toMatchObject({ action: "merged", conversation_id: design })
    const res = await messages(w.owner.token, job.id, "C02", [
      { ts: existing.ts, user: "U03", text: "Would overwrite" },
      { ts: "1700000000.000001", user: "U03", text: "Mise à jour du design · デザイン更新" },
    ])
    expect(res).toMatchObject({ imported: 1, skipped: 1 })
    const list = await history(w.owner.token, design)
    expect(list.find((m) => m.ts === existing.ts)!.text).toBe("Ours")
    expect(list.map((m) => m.text)).toContain("Mise à jour du design · デザイン更新")
    expect((await status(w.owner.token, job.id)).counts).toMatchObject({ messages: 1, messages_skipped: 1 })

    // A DM with the same people goes into the existing one, merge or not.
    const job2 = await start(w.owner.token)
    const ana = (
      await ok<{ user: { id: string } }>("users.lookupByEmail", { email: `ana@${name}.test` }, w.owner.token)
    ).user.id
    const dm = await ok<{ channel: { id: string } }>("conversations.open", { users: ana }, w.owner.token)
    await ok("campflare.import.users", { job: job2.id, users: exportUsers(name) }, w.owner.token)
    const mapped = await ok<{ conversations: { conversation_id: string; action: string }[] }>(
      "campflare.import.conversations",
      { job: job2.id, conversations: [{ id: "D09", type: "im", members: ["U02", "U01"] }] },
      w.owner.token,
    )
    expect(mapped.conversations[0]).toMatchObject({ action: "merged", conversation_id: dm.channel.id })
  })

  it("undoes everything it wrote, before or after finishing", async () => {
    const { w, ana, name } = await setUp()
    const usersBefore = await env.DB.prepare("SELECT count(*) AS n FROM users WHERE team_id = ?")
      .bind(w.teamId)
      .first<{ n: number }>()
    const job = await start(w.owner.token, { merge_into_existing: true })
    const { conversation } = await prepare(w.owner.token, name, job.id)
    await messages(w.owner.token, job.id, "C01", [...chunk1, ...chunk2])
    await messages(w.owner.token, job.id, "C03", [{ ts: "1700000000.000009", user: "U03", text: "東京タワー" }])
    // Someone reacts to and saves an imported message meanwhile: those go with it.
    await ok("reactions.add", { channel: w.general, timestamp: "1700000000.000100", name: "eyes" }, ana.token)
    await ok("stars.add", { channel: w.general, timestamp: "1700000000.000100" }, ana.token)
    const ours = await ok<{ ts: string }>("chat.postMessage", { channel: w.general, text: "Still here" }, ana.token)

    const { removed, job: undone } = await undo(w.owner.token, job.id)
    expect(undone.state).toBe("undone")
    expect(removed).toMatchObject({ messages: 13, conversations: 4, users: 6 })
    const general = await history(w.owner.token, w.general)
    expect(general.map((m) => m.ts)).toEqual([ours.ts])
    const usersAfter = await env.DB.prepare("SELECT count(*) AS n FROM users WHERE team_id = ?")
      .bind(w.teamId)
      .first<{ n: number }>()
    expect(usersAfter!.n).toBe(usersBefore!.n)
    await expectError(
      "conversations.info",
      { channel: conversation.get("C03")!.conversation_id },
      w.owner.token,
      "channel_not_found",
    )
    // #general keeps its own members: only memberships the import added went.
    const members = await ok<{ members: string[] }>("conversations.members", { channel: w.general }, w.owner.token)
    expect(members.members.toSorted()).toEqual([w.owner.id, ana.id].toSorted())
    expect((await ok<{ items: unknown[] }>("stars.list", {}, ana.token)).items).toEqual([])
    // Done is done; and it can run again from scratch.
    expect((await ok<{ done: boolean }>("campflare.import.undo", { job: job.id }, w.owner.token)).done).toBe(true)
    await expectError("campflare.import.users", { job: job.id, users: [] }, w.owner.token, "import_not_running")

    // After finishing too, within the window.
    const job2 = await start(w.owner.token)
    const second = await prepare(w.owner.token, name, job2.id)
    await messages(w.owner.token, job2.id, "C03", [{ ts: "1700000000.000009", user: "U03", text: "大阪" }])
    await finish(w.owner.token, job2.id)
    // Someone wrote in a conversation it made: refused.
    const tokyo = second.conversation.get("C03")!.conversation_id!
    await ok("conversations.join", { channel: tokyo }, ana.token)
    await expectError("campflare.import.undo", { job: job2.id }, w.owner.token, "import_in_use")
    await env.DB.prepare("DELETE FROM messages WHERE channel_id = ? AND import_job IS NULL").bind(tokyo).run()
    expect((await undo(w.owner.token, job2.id)).job.state).toBe("undone")

    // Past the window: refused.
    const job3 = await start(w.owner.token)
    await finish(w.owner.token, job3.id)
    await env.DB.prepare("UPDATE import_jobs SET finished = ? WHERE id = ?")
      .bind(Math.floor(Date.now() / 1000) - UNDO_WINDOW_SECONDS - 10, job3.id)
      .run()
    await expectError("campflare.import.undo", { job: job3.id }, w.owner.token, "undo_window_passed")
  })

  it("attaches uploaded files in place of their lines", async () => {
    const { w, name } = await setUp()
    const job = await start(w.owner.token, { files: "download" })
    expect(job.options.files).toBe("download")
    await prepare(w.owner.token, name, job.id)
    const res = await messages(w.owner.token, job.id, "C01", chunk2)
    expect(res.files_needed).toEqual([{ id: "F01", ts: "1700000700.000800" }])
    const ts = "1700000700.000800"

    const upload = async (bytes: string) => {
      const r = await ok<{ upload_url: string; file_id: string }>(
        "files.getUploadURLExternal",
        { filename: "plan.pdf", length: bytes.length },
        w.owner.token,
      )
      return { ...r, put: () => SELF.fetch(r.upload_url, { method: "POST", body: bytes }) }
    }
    const pending = await upload("%PDF-1.4 plan")
    const files = (list: unknown[], extra = {}) => ({ job: job.id, conversation: "C01", ts, files: list, ...extra })
    await expectError(
      "campflare.import.files",
      files([{ source_id: "F01", file_id: pending.file_id }]),
      w.owner.token,
      "file_upload_not_complete",
    )
    await pending.put()
    await expectError(
      "campflare.import.files",
      files([{ source_id: "F09", file_id: pending.file_id }]),
      w.owner.token,
      "file_not_found",
    )
    await expectError(
      "campflare.import.files",
      files([{ source_id: "F01", file_id: "FNOPE" }]),
      w.owner.token,
      "file_not_found",
    )
    await expectError(
      "campflare.import.files",
      files([{ source_id: "F01", file_id: pending.file_id }], { ts: "1700000000.000100" }),
      w.owner.token,
      "message_not_found",
    )
    await expectError("campflare.import.files", files([{ source_id: "F01" }]), w.owner.token, "invalid_arguments")
    await expectError("campflare.import.files", files([]), w.owner.token, "invalid_arguments")
    await expectError(
      "campflare.import.files",
      { job: job.id, conversation: "C01", files: [] },
      w.owner.token,
      "invalid_arguments",
    )
    await expectError(
      "campflare.import.files",
      files(Array.from({ length: LIMITS.files + 1 }, (_, i) => ({ source_id: `F${i}`, file_id: "F" }))),
      w.owner.token,
      "limit_exceeded",
    )

    const attached = await ok<{ attached: number; skipped: number }>(
      "campflare.import.files",
      files([{ source_id: "F01", file_id: pending.file_id, title: "Le plan · 計画" }]),
      w.owner.token,
    )
    expect(attached).toMatchObject({ attached: 1, skipped: 0 })
    const general = res.channel
    const m = (await history(w.owner.token, general)).find((x) => x.ts === ts)!
    expect(m.text).toBe("Here is the plan\n[file not imported: old.png]")
    expect(m.files).toEqual([expect.objectContaining({ id: pending.file_id, title: "Le plan · 計画" })])
    const again = await ok<{ attached: number; skipped: number }>(
      "campflare.import.files",
      files([{ source_id: "F01", file_id: pending.file_id }]),
      w.owner.token,
    )
    expect(again).toMatchObject({ attached: 0, skipped: 1 })
    // Re-sent, the chunk needs nothing more.
    expect((await messages(w.owner.token, job.id, "C01", chunk2)).files_needed).toEqual([])
    expect((await status(w.owner.token, job.id)).counts).toMatchObject({
      files: 1,
      files_attached: 1,
      files_skipped: 0,
    })

    // The file goes with an undo, bytes and all.
    await undo(w.owner.token, job.id)
    expect(await env.FILES.get(`${w.teamId}/${pending.file_id}`)).toBeNull()
  })

  it("resumes a running job by its export's fingerprint, and won't import one twice", async () => {
    const { w } = await setUp()
    const a = await ok<{ job: Job; resumed: boolean }>("campflare.import.start", { fingerprint: "abc" }, w.owner.token)
    const b = await ok<{ job: Job; resumed: boolean }>("campflare.import.start", { fingerprint: "abc" }, w.owner.token)
    expect(a.resumed).toBe(false)
    expect(b).toMatchObject({ resumed: true, job: { id: a.job.id } })
    await finish(w.owner.token, a.job.id)
    const twice = await expectError("campflare.import.start", { fingerprint: "abc" }, w.owner.token, "already_imported")
    expect(twice.job).toMatchObject({ id: a.job.id })
    await undo(w.owner.token, a.job.id)
    expect(
      (await ok<{ resumed: boolean }>("campflare.import.start", { fingerprint: "abc" }, w.owner.token)).resumed,
    ).toBe(false)
    await expectError("campflare.import.start", { format: "zip" }, w.owner.token, "invalid_arguments")
    await expectError("campflare.import.start", { files: "maybe" }, w.owner.token, "invalid_arguments")
    await expectError("campflare.import.start", { fingerprint: "x".repeat(201) }, w.owner.token, "invalid_arguments")
  })

  it("is for admins, with the import scope", async () => {
    const { w, ana } = await setUp()
    await expectError("campflare.import.start", {}, ana.token, "not_an_admin")
    await expectError("campflare.import.list", {}, ana.token, "not_an_admin")
    const job = await start(w.owner.token)
    await expectError("campflare.import.status", { job: job.id }, ana.token, "not_an_admin")
    const narrow = await ok<{ token: string }>("campflare.tokens.create", { preset: "write" }, w.owner.token)
    const denied = await expectError("campflare.import.start", {}, narrow.token, "missing_scope")
    expect(denied.needed).toBe("admin.import:write")
    await expectError("campflare.import.list", {}, narrow.token, "missing_scope")
    const app = await w.addApp("Importer")
    await expectError("campflare.import.start", {}, app.botToken, "not_allowed_token_type")
    // Another workspace's job is no job.
    const other = await workspace(teamName())
    await expectError("campflare.import.status", { job: job.id }, other.owner.token, "import_not_found")
    await expectError("campflare.import.status", {}, other.owner.token, "import_not_found")
  })

  it("limits what one call takes, and checks what it is given", async () => {
    const { w, name } = await setUp()
    const job = await start(w.owner.token)
    await prepare(w.owner.token, name, job.id)
    const many = (count: number, make: (i: number) => unknown) => Array.from({ length: count }, (_, i) => make(i))
    const tooMany = await expectError(
      "campflare.import.messages",
      { job: job.id, conversation: "C01", messages: many(LIMITS.messages + 1, (i) => ({ ts: `1700000000.${i}` })) },
      w.owner.token,
      "limit_exceeded",
    )
    expect(tooMany.max).toBe(LIMITS.messages)
    const big = "あ".repeat(Math.ceil(LIMITS.messageBytes / 3 / 10) + 10)
    await expectError(
      "campflare.import.messages",
      { job: job.id, conversation: "C01", messages: many(10, (i) => ({ ts: `1700000000.${i}`, text: big })) },
      w.owner.token,
      "limit_exceeded",
    )
    await expectError(
      "campflare.import.users",
      { job: job.id, users: many(LIMITS.users + 1, (i) => ({ id: `U${i}` })) },
      w.owner.token,
      "limit_exceeded",
    )
    await expectError(
      "campflare.import.conversations",
      { job: job.id, conversations: many(LIMITS.conversations + 1, (i) => ({ id: `C${i}`, type: "channel" })) },
      w.owner.token,
      "limit_exceeded",
    )
    const bad = (method: string, args: Record<string, unknown>, error = "invalid_arguments") =>
      expectError(method, { job: job.id, ...args }, w.owner.token, error)
    await bad("campflare.import.users", { users: "nope" })
    await bad("campflare.import.users", { users: [{ name: "no id" }] })
    await bad("campflare.import.conversations", { conversations: {} })
    await bad("campflare.import.conversations", { conversations: [{ id: "C1", type: "forum" }] })
    await bad("campflare.import.messages", { conversation: "C01", messages: {} })
    await bad("campflare.import.messages", { conversation: "C01", messages: [42] })
    await bad("campflare.import.messages", { conversation: "C01", messages: [{ ts: "yesterday" }] })
    await bad("campflare.import.messages", { conversation: "C01", messages: [{ ts: "1700000000.1", thread_ts: "x" }] })
    await bad("campflare.import.messages", { conversation: "C99", messages: [] }, "channel_not_found")
    await expectError("campflare.import.status", { job: "JNOPE" }, w.owner.token, "import_not_found")
    // An empty chunk, and users with nothing new, write nothing.
    expect(await messages(w.owner.token, job.id, "C01", [])).toMatchObject({ imported: 0, skipped: 0 })
    expect(await ok("campflare.import.users", { job: job.id, users: [] }, w.owner.token)).toMatchObject({ mapped: 0 })
    const skipped = await ok<{ conversations: { action: string }[] }>(
      "campflare.import.conversations",
      { job: job.id, conversations: [{ id: "D77", type: "im", members: [] }] },
      w.owner.token,
    )
    expect(skipped.conversations[0]!.action).toBe("skipped")
  })

  it("writes a big chunk in several statements", async () => {
    const { w, name } = await setUp()
    const job = await start(w.owner.token)
    await prepare(w.owner.token, name, job.id)
    // ~2.4 MB of text: more than D1 binds in one argument.
    const text = "Ünïcödé テキスト ".repeat(120)
    const list = Array.from({ length: 1000 }, (_, i) => ({
      ts: `1700100000.${String(i).padStart(6, "0")}`,
      user: i % 2 ? "U03" : "U04",
      text,
      reactions: [{ name: "eyes", users: ["U01"] }],
    }))
    const res = await messages(w.owner.token, job.id, "C03", list)
    expect(res.imported).toBe(1000)
    expect((await status(w.owner.token, job.id)).counts).toMatchObject({ messages: 1000, reactions: 1000 })
  })
})

describe("import helpers", () => {
  it("rewrites mentions and links, makes handles and names", () => {
    const unmapped = new Set<string>()
    const users = new Map([["U1", "UA"]])
    const conversations = new Map([["C1", "CA"]])
    expect(rewriteText("<@U1> <@U1|ana> <@U2> <@W3|zoë> <#C1|général> <#C2>", users, conversations, unmapped)).toBe(
      "<@UA> <@UA> <@U2> @zoë <#CA> <#C2>",
    )
    expect([...unmapped]).toEqual(["U2", "W3"])
    expect(handleFrom("Françoise Dupont")).toBe("francoise-dupont")
    expect(handleFrom("__王芳")).toBe("user")
    expect(handleFrom("")).toBe("user")
    expect(channelNameFrom("#Café Olé")).toBe("café-olé")
    expect(channelNameFrom("!!")).toBe("-")
    expect(channelNameFrom("")).toBe("imported")
    expect(candidates("a", 4)).toEqual(["a", "a-imported", "a-imported-2", "a-imported-3"])
    expect(withoutFileLine("a\n[file not imported: x]\nb", "x")).toBe("a\nb")
    expect(withoutFileLine("a", "x")).toBe("a")
    expect(groups([1, 2, 3], 4)).toEqual([[1], [2], [3]])
    expect(groups([], 4)).toEqual([])
  })
})

it("answers calls without a job for a member too", async () => {
  // A sanity check that nothing here needs a job to say who may call.
  const w = await workspace(teamName())
  const body = await call("campflare.import.finish", {}, w.owner.token)
  expect(body.error).toBe("import_not_found")
})
