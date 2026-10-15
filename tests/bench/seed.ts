import { createHash } from "node:crypto"

// A deterministic workspace, written as SQL and loaded into local D1 before
// the server starts: far faster than posting tens of thousands of messages
// through the API, and the same data on every run.

export interface Size {
  users: number
  /** Messages in #busy, the channel the read benchmarks page through. */
  busyMessages: number
  /** Other channels, and messages in each. */
  channels: number
  channelMessages: number
  /** Replies in the one long thread conversations.replies reads. */
  threadReplies: number
  /** Users in #fanout, each with a live RTM link in the fan-out benchmark. */
  fanout: number
  /** The owner's messages in #scratch for chat.delete: one per timed request, plus warm-up. */
  deletable: number
}

export const SIZES: Record<"quick" | "standard", Size> = {
  quick: {
    users: 100,
    busyMessages: 2_000,
    channels: 5,
    channelMessages: 200,
    threadReplies: 50,
    fanout: 20,
    deletable: 100,
  },
  standard: {
    users: 500,
    busyMessages: 20_000,
    channels: 30,
    channelMessages: 1_000,
    threadReplies: 200,
    fanout: 100,
    deletable: 250,
  },
}

export interface Dataset {
  teamId: string
  owner: { id: string; token: string }
  users: { id: string; name: string; token: string }[]
  bot: { userId: string; token: string }
  general: string
  busy: string
  fanout: string
  /** The head of the long thread in #busy. */
  threadTs: string
  /** A message in #busy for reactions.add/remove. */
  reactTs: string
  /** #scratch: the owner's messages there, for chat.update (the first) and chat.delete (the rest). */
  scratch: string
  scratchTs: string[]
  messages: number
}

/** A small seeded PRNG (mulberry32), so every run builds the same workspace. */
function rng(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const WORDS = (
  "deploy build release review merge branch test flaky green red latency database query index cache " +
  "worker durable object socket event message thread reply channel search token upload file image " +
  "lunch coffee meeting standup retro roadmap ticket bug fix ship rollback incident alert dashboard " +
  // Other scripts, evenly: CJK and accented Latin.
  "部署 失敗 測試 會議 デプロイ 失敗 会議 確認 배포 실패 회의 점심 " +
  "despliegue reunión señal déploiement réunion café Bereitstellung Besprechung München"
).split(" ")

const sqlString = (v: string) => `'${v.replace(/'/g, "''")}'`
const sqlValue = (v: string | number | null) => (v === null ? "NULL" : typeof v === "number" ? String(v) : sqlString(v))
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex")

const id = (prefix: string, n: number) => `${prefix}${String(n).padStart(9, "0")}`
const tsOf = (seconds: number, n: number) =>
  `${String(seconds).padStart(10, "0")}.${String(n % 1_000_000).padStart(6, "0")}`

export function buildSeed(size: Size): { sql: string; dataset: Dataset } {
  const random = rng(42)
  const pick = <T>(xs: T[]) => xs[Math.floor(random() * xs.length)]!
  const lines: string[] = []
  const insert = (table: string, columns: string[], rows: (string | number | null)[][]) => {
    // Several rows per statement keeps the file small and the load fast.
    for (let i = 0; i < rows.length; i += 200) {
      const values = rows
        .slice(i, i + 200)
        .map((r) => `(${r.map(sqlValue).join(", ")})`)
        .join(",\n")
      lines.push(`INSERT INTO ${table} (${columns.join(", ")}) VALUES\n${values};`)
    }
  }

  const now = Math.floor(Date.now() / 1000)
  const teamId = "TBENCH0001"
  insert("teams", ["id", "name", "domain", "created"], [[teamId, "Bench", "bench", now]])

  const users = Array.from({ length: size.users }, (_, i) => ({
    id: id("U", i),
    name: i === 0 ? "owner" : `user${i}`,
    token: `xoxp-${teamId}-bench${String(i).padStart(6, "0")}`,
  }))
  const botUserId = id("U", size.users)
  insert(
    "users",
    ["id", "team_id", "name", "real_name", "email", "is_admin", "is_owner", "is_bot", "bot_id", "updated", "created"],
    [
      ...users.map((u, i) => [
        u.id,
        teamId,
        u.name,
        u.name.toUpperCase(),
        `${u.name}@bench.test`,
        +(i === 0),
        +(i === 0),
        0,
        null,
        now,
        now,
      ]),
      [botUserId, teamId, "benchbot", "Bench Bot", null, 0, 0, 1, "BBENCH0001", now, now],
    ],
  )
  insert(
    "apps",
    ["id", "team_id", "name", "bot_id", "bot_user_id", "installer_user_id", "created"],
    [["ABENCH0001", teamId, "Bench Bot", "BBENCH0001", botUserId, users[0]!.id, now]],
  )
  const botToken = `xoxb-${teamId}-benchbot`
  insert(
    "tokens",
    ["hash", "team_id", "kind", "user_id", "app_id", "scopes", "created"],
    [
      // Presets by name, as migration 0018 stores them: a person's own token, an app's bot.
      ...users.map((u) => [sha256(u.token), teamId, "user", u.id, null, "full", now]),
      [sha256(botToken), teamId, "bot", botUserId, "ABENCH0001", "bot", now],
    ],
  )

  // Channels: #general (everyone), #busy, #fanout, then the rest; plus the owner's DMs.
  const conversations: (string | number | null)[][] = []
  const members: (string | number)[][] = []
  const channel = (cid: string, name: string, memberIds: string[]) => {
    conversations.push([cid, teamId, "channel", name, +(name === "general"), users[0]!.id, null, now, now])
    for (const u of memberIds) members.push([cid, u, now])
  }
  const general = id("C", 0)
  const busy = id("C", 1)
  const fanout = id("C", 2)
  channel(
    general,
    "general",
    users.map((u) => u.id),
  )
  channel(busy, "busy", [...users.slice(0, Math.min(200, size.users)).map((u) => u.id), botUserId])
  channel(
    fanout,
    "fanout",
    users.slice(0, size.fanout + 1).map((u) => u.id),
  )
  const scratch = id("C", 999)
  channel(
    scratch,
    "scratch",
    users.slice(0, Math.min(200, size.users)).map((u) => u.id),
  )
  const others: string[] = []
  for (let i = 0; i < size.channels; i++) {
    const cid = id("C", 3 + i)
    others.push(cid)
    const n = 20 + Math.floor(random() * 80)
    const ms = new Set([users[0]!.id, ...Array.from({ length: n }, () => pick(users).id)])
    channel(cid, `channel-${i}`, [...ms])
  }
  for (let i = 1; i <= Math.min(20, size.users - 1); i++) {
    const did = id("D", i)
    const key = [users[0]!.id, users[i]!.id].toSorted().join(",")
    conversations.push([did, teamId, "im", users[i]!.id, 0, users[0]!.id, key, now, now])
    members.push([did, users[0]!.id, now], [did, users[i]!.id, now])
  }
  insert(
    "conversations",
    ["id", "team_id", "kind", "name", "is_general", "creator", "member_key", "created", "updated"],
    conversations,
  )
  // DMs are private; channels are public.
  lines.push(`UPDATE conversations SET is_private = 1 WHERE kind = 'im';`)
  insert("members", ["conversation_id", "user_id", "joined"], members)

  // Messages, a few seconds apart over the last weeks. Every 25th in #busy
  // starts a short thread, a third get reactions, and one long thread ends it.
  const messages: (string | number | null)[][] = []
  const reactions: (string | number)[][] = []
  const text = () => Array.from({ length: 4 + Math.floor(random() * 12) }, () => pick(WORDS)).join(" ")
  const busyAuthors = users.slice(0, Math.min(200, size.users))
  let clock = now - 30 * 86_400
  let seq = 0
  const message = (
    cid: string,
    author: string,
    extra: Partial<
      Record<"thread_ts" | "parent" | "reply_count" | "reply_users" | "latest_reply", string | number>
    > = {},
  ) => {
    const ts = tsOf((clock += 1 + Math.floor(random() * 5)), seq++)
    messages.push([
      cid,
      ts,
      teamId,
      author,
      text(),
      (extra.thread_ts as string) ?? null,
      (extra.parent as string) ?? null,
      (extra.reply_count as number) ?? 0,
      (extra.reply_users as string) ?? "[]",
      (extra.latest_reply as string) ?? null,
    ])
    if (random() < 0.33) {
      const reactors = new Set(Array.from({ length: 1 + Math.floor(random() * 3) }, () => pick(busyAuthors).id))
      for (const u of reactors)
        reactions.push([cid, ts, pick(["+1", "eyes", "tada", "fire", "white_check_mark"]), u, now])
    }
    return ts
  }
  const thread = (cid: string, replies: number, authors: typeof users) => {
    const headIndex = messages.length
    const head = message(cid, pick(authors).id)
    const replyUsers = new Set<string>()
    let last = head
    for (let r = 0; r < replies; r++) {
      const author = pick(authors).id
      replyUsers.add(author)
      last = message(cid, author, { thread_ts: head, parent: messages[headIndex]![3] as string })
    }
    const row = messages[headIndex]!
    row[5] = head
    row[7] = replies
    row[8] = JSON.stringify([...replyUsers].slice(0, 50))
    row[9] = last
    return head
  }
  for (const cid of others) {
    for (let i = 0; i < size.channelMessages; i++) message(cid, pick(users).id)
  }
  let reactTs = ""
  for (let i = 0; i < size.busyMessages;) {
    if (i % 25 === 24) {
      thread(busy, 5, busyAuthors)
      i += 6
    } else {
      reactTs = message(busy, pick(busyAuthors).id)
      i++
    }
  }
  const threadTs = thread(busy, size.threadReplies, busyAuthors)
  // The owner's messages in #scratch, with #busy's members, to edit and delete. Fixed text and no
  // reactions, so they change no search result and no other benchmark.
  const scratchTs: string[] = []
  for (let i = 0; i < size.deletable + 1; i++) {
    const ts = tsOf((clock += 1), seq++)
    scratchTs.push(ts)
    messages.push([scratch, ts, teamId, users[0]!.id, `scratch ${i}`, null, null, 0, "[]", null])
  }
  insert(
    "messages",
    [
      "channel_id",
      "ts",
      "team_id",
      "user_id",
      "text",
      "thread_ts",
      "parent_user_id",
      "reply_count",
      "reply_users",
      "latest_reply",
    ],
    messages,
  )
  // Who takes part in each thread, as replies posted through the API would have recorded it (migration 0019).
  lines.push(
    `INSERT OR IGNORE INTO thread_participants (channel_id, thread_ts, user_id)
     SELECT channel_id, thread_ts, user_id FROM messages WHERE thread_ts IS NOT NULL AND thread_ts != ts
     UNION SELECT channel_id, thread_ts, parent_user_id FROM messages WHERE thread_ts IS NOT NULL AND thread_ts != ts;`,
  )
  // Reactions may repeat (same user, same emoji): keep one.
  insert(
    "reactions",
    ["channel_id", "ts", "name", "user_id", "created"],
    [...new Map(reactions.map((r) => [r.slice(0, 4).join("/"), r])).values()],
  )

  return {
    sql: lines.join("\n"),
    dataset: {
      teamId,
      owner: { id: users[0]!.id, token: users[0]!.token },
      users,
      bot: { userId: botUserId, token: botToken },
      general,
      busy,
      fanout,
      threadTs,
      reactTs,
      scratch,
      scratchTs,
      messages: messages.length,
    },
  }
}
