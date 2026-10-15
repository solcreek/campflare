import type { Actor, Ctx } from "../api/context"
import { CampflareError, invalidArguments } from "../api/errors"
import { normalizeTs, tsToMicros } from "../api/ids"
import { MAX_TEXT } from "../db/messages"
import { stmt } from "../db/query"
import { bump, CHANGES, limitExceeded, LIMITS, loadJob, MAX_UNMAPPED, type Counts } from "./job"
import { fileLine, linkedConversations, mentionedUsers, rewriteText, SYSTEM_USER_ID } from "./text"

// campflare.import.messages: one chunk of one conversation's messages, written
// straight into D1 in a batch, never through postMessage: no events, no
// activity, no notifications, no app deliveries (docs/import.md, No events).

export interface ExportFile {
  id?: string
  name?: string
  title?: string
  mode?: string
}

export interface ExportMessage {
  ts: string
  user?: string
  username?: string
  bot_id?: string
  bot_profile?: { name?: string }
  user_profile?: { real_name?: string; display_name?: string; name?: string }
  subtype?: string
  text?: string
  thread_ts?: string
  parent_user_id?: string
  edited?: { user?: string; ts?: string }
  reactions?: { name?: string; users?: string[] }[]
  files?: ExportFile[]
  pinned_to?: string[]
  pinned_info?: { pinned_by?: string; pinned_ts?: number }
  blocks?: unknown[]
  attachments?: unknown[]
}

/** A message as stored: the columns of `messages` an import writes. */
interface Row {
  ts: string
  user_id: string | null
  username: string | null
  subtype: string | null
  text: string
  blocks: string | null
  attachments: string | null
  thread_ts: string | null
  parent_user_id: string | null
  edited_ts: string | null
  edited_user: string | null
  pinned_by: string | null
  pinned_at: number | null
}

/** D1 binds a string of at most 2 MB: a chunk is written in statements of at most this much JSON. */
const STATEMENT_BYTES = 900_000

/** Values split into groups whose JSON stays under STATEMENT_BYTES. */
export function groups<T>(values: T[], max = STATEMENT_BYTES): T[][] {
  const out: T[][] = []
  let group: T[] = []
  let size = 2
  for (const v of values) {
    const bytes = new TextEncoder().encode(JSON.stringify(v)).byteLength + 1
    if (group.length && size + bytes > max) {
      out.push(group)
      group = []
      size = 2
    }
    group.push(v)
    size += bytes
  }
  if (group.length) out.push(group)
  return out
}

const tsOf = (value: unknown) =>
  typeof value === "string" || typeof value === "number" ? normalizeTs(String(value)) : undefined

export async function importMessages(ctx: Ctx<Actor>) {
  const job = await loadJob(ctx, { running: true })
  const source = ctx.args.req("conversation", "channel_not_found")
  const raw = ctx.args.values.messages
  const size = new TextEncoder().encode(typeof raw === "string" ? raw : JSON.stringify(raw ?? null)).byteLength
  if (size > LIMITS.messageBytes) throw limitExceeded("bytes of messages", LIMITS.messageBytes)
  const list = ctx.args.json<ExportMessage[]>("messages")
  if (!Array.isArray(list)) throw invalidArguments("messages must be a JSON array")
  if (list.length > LIMITS.messages) throw limitExceeded("messages", LIMITS.messages)
  const cursor = ctx.args.str("cursor")

  // Every id the chunk refers to, mapped in one batch with the conversation.
  const people = new Set<string>()
  const linked = new Set<string>()
  for (const m of list) {
    if (!m || typeof m !== "object") throw invalidArguments("each message must be an object")
    for (const id of [m.user, m.parent_user_id, m.edited?.user, m.pinned_info?.pinned_by]) if (id) people.add(id)
    for (const r of m.reactions ?? []) for (const u of r.users ?? []) people.add(u)
    if (typeof m.text === "string") {
      for (const id of mentionedUsers(m.text)) people.add(id)
      for (const id of linkedConversations(m.text)) linked.add(id)
    }
  }
  const db = ctx.env.DB
  const [conversation, users, conversations] = await db.batch([
    stmt(
      db,
      `SELECT ic.conversation_id AS id, c.team_id FROM import_conversations ic JOIN conversations c ON c.id = ic.conversation_id
       WHERE ic.job_id = ? AND ic.source_id = ?`,
      job.id,
      source,
    ),
    stmt(
      db,
      "SELECT source_id, user_id FROM import_users WHERE job_id = ? AND source_id IN (SELECT value FROM json_each(?))",
      job.id,
      JSON.stringify([...people]),
    ),
    stmt(
      db,
      "SELECT source_id, conversation_id FROM import_conversations WHERE job_id = ? AND source_id IN (SELECT value FROM json_each(?))",
      job.id,
      JSON.stringify([...linked]),
    ),
  ])
  const c = conversation!.results[0] as { id: string; team_id: string } | undefined
  if (!c) throw new CampflareError("channel_not_found")
  const userOf = new Map(
    (users!.results as { source_id: string; user_id: string }[]).map((r) => [r.source_id, r.user_id]),
  )
  userOf.set(SYSTEM_USER_ID, SYSTEM_USER_ID)
  const conversationOf = new Map(
    (conversations!.results as { source_id: string; conversation_id: string }[]).map((r) => [
      r.source_id,
      r.conversation_id,
    ]),
  )
  const unmapped = new Set<string>()
  const mapUser = (id: string | undefined) => {
    if (!id) return null
    const to = userOf.get(id)
    if (!to) unmapped.add(id)
    return to ?? null
  }

  const rows = new Map<string, Row>()
  const reactions: [string, string, string][] = []
  const files: { ts: string; id: string; name: string }[] = []
  for (const [i, m] of list.entries()) {
    const ts = tsOf(m.ts)
    if (!ts) throw invalidArguments(`messages[${i}].ts must be a timestamp`)
    const threadTs = m.thread_ts === undefined ? null : tsOf(m.thread_ts)
    if (threadTs === undefined) throw invalidArguments(`messages[${i}].thread_ts must be a timestamp`)
    const user = mapUser(m.user)
    let text = rewriteText(typeof m.text === "string" ? m.text : "", userOf, conversationOf, unmapped)
    const lines: string[] = []
    for (const f of m.files ?? []) {
      const name = f.name || f.title || "file"
      lines.push(fileLine(name))
      // Slack hides some (free plans' old files) or tombstones them: nothing to attach later.
      if (f.id && f.mode !== "hidden_by_limit" && f.mode !== "tombstone") files.push({ ts, id: f.id, name })
    }
    if (lines.length) text = [text, ...lines].filter(Boolean).join("\n")
    const pinned = Array.isArray(m.pinned_to) && m.pinned_to.includes(source)
    const editedTs = m.edited?.ts === undefined ? null : (tsOf(m.edited.ts) ?? null)
    rows.set(ts, {
      ts,
      user_id: user,
      // A bot's name, or an unmapped person's, shown in place of a user (bot_id is Slack's: dropped).
      username:
        m.username ??
        m.bot_profile?.name ??
        (m.user && !user ? (m.user_profile?.real_name ?? m.user_profile?.name ?? m.user) : null) ??
        null,
      subtype: m.subtype ?? null,
      text: text.slice(0, MAX_TEXT),
      // Slack's rich_text blocks repeat the text, with Slack's ids inside: kept only when there's no text.
      blocks: !text && Array.isArray(m.blocks) && m.blocks.length ? JSON.stringify(m.blocks) : null,
      attachments: Array.isArray(m.attachments) && m.attachments.length ? JSON.stringify(m.attachments) : null,
      thread_ts: threadTs,
      parent_user_id: threadTs && threadTs !== ts ? mapUser(m.parent_user_id) : null,
      edited_ts: editedTs,
      edited_user: editedTs ? mapUser(m.edited?.user) : null,
      pinned_by: pinned ? (mapUser(m.pinned_info?.pinned_by) ?? user ?? ctx.auth.user.id) : null,
      pinned_at: pinned ? (m.pinned_info?.pinned_ts ?? Math.floor(tsToMicros(ts) / 1_000_000)) : null,
    })
    for (const r of m.reactions ?? []) {
      if (!r.name) continue
      for (const u of r.users ?? []) {
        const to = mapUser(u)
        if (to) reactions.push([ts, r.name.slice(0, 100), to])
      }
    }
  }

  const all = [...rows.values()]
  const keys = JSON.stringify(all.map((r) => r.ts))
  const threads = JSON.stringify([...new Set(all.flatMap((r) => (r.thread_ts ? [r.thread_ts] : [])))])
  const counts = JSON.parse(job.counts) as Counts
  const known = new Set((counts.unmapped_users as string[] | undefined) ?? [])
  const added = [...unmapped].filter((id) => !known.has(id))
  const ours = "EXISTS (SELECT 1 FROM messages WHERE channel_id = ?1 AND ts = value ->> 0 AND import_job = ?2)"
  const results = await db.batch([
    // Messages already here that the job didn't write (merging): never touched, counted.
    bump(db, job.id, {
      messages_skipped: {
        sql: "SELECT count(*) FROM json_each(?) j JOIN messages m ON m.channel_id = ? AND m.ts = j.value WHERE m.import_job IS NOT ?",
        params: [keys, c.id, job.id],
      },
    }),
    // Pinned and unpinned apart, so each insert's count says which it was.
    ...[all.filter((r) => r.pinned_at), all.filter((r) => !r.pinned_at)].flatMap((set, pinned) =>
      groups(set).flatMap((group) => [
        stmt(
          db,
          `INSERT OR IGNORE INTO messages (channel_id, ts, team_id, user_id, username, subtype, text, blocks, attachments,
             thread_ts, parent_user_id, edited_ts, edited_user, pinned_by, pinned_at, import_job)
           SELECT ?, value ->> 'ts', ?, value ->> 'user_id', value ->> 'username', value ->> 'subtype', value ->> 'text',
             value ->> 'blocks', value ->> 'attachments', value ->> 'thread_ts', value ->> 'parent_user_id',
             value ->> 'edited_ts', value ->> 'edited_user', value ->> 'pinned_by', value ->> 'pinned_at', ?
           FROM json_each(?)`,
          c.id,
          c.team_id,
          job.id,
          JSON.stringify(group),
        ),
        bump(db, job.id, pinned === 0 ? { messages: CHANGES, pins: CHANGES } : { messages: CHANGES }),
      ]),
    ),
    // Reactions and files only on the job's own messages.
    ...groups(reactions).flatMap((group) => [
      stmt(
        db,
        `INSERT OR IGNORE INTO reactions (channel_id, ts, name, user_id, created, import_job)
         SELECT ?1, value ->> 0, value ->> 1, value ->> 2, CAST(value ->> 0 AS INTEGER), ?2 FROM json_each(?3)
         WHERE ${ours}`,
        c.id,
        job.id,
        JSON.stringify(group),
      ),
      bump(db, job.id, { reactions: CHANGES }),
    ]),
    ...groups(files.map((f) => [f.ts, f.id, f.name])).flatMap((group) => [
      stmt(
        db,
        `INSERT OR IGNORE INTO import_files (job_id, source_id, source_conversation, file_id, channel_id, ts, name)
         SELECT ?2, value ->> 1, ?4, NULL, ?1, value ->> 0, value ->> 2 FROM json_each(?3) WHERE ${ours}`,
        c.id,
        job.id,
        JSON.stringify(group),
        source,
      ),
      bump(db, job.id, { files: CHANGES }),
    ]),
    // The threads the chunk touches, recounted from what is stored: heads and replies may come in any order.
    recountThreads(db, c.id, job.id, { sql: "SELECT value FROM json_each(?)", params: [threads] }),
    ...(added.length
      ? [
          stmt(
            db,
            "UPDATE import_jobs SET counts = json_set(counts, '$.unmapped_users', json(?)) WHERE id = ?",
            JSON.stringify([...known, ...added].slice(0, MAX_UNMAPPED)),
            job.id,
          ),
        ]
      : []),
    ...(cursor
      ? [
          stmt(
            db,
            "UPDATE import_conversations SET cursor = ? WHERE job_id = ? AND source_id = ?",
            cursor,
            job.id,
            source,
          ),
        ]
      : []),
    stmt(
      db,
      `SELECT source_id AS id, ts FROM import_files WHERE job_id = ? AND channel_id = ? AND file_id IS NULL
       AND ts IN (SELECT value FROM json_each(?))`,
      job.id,
      c.id,
      keys,
    ),
    stmt(
      db,
      "SELECT count(*) AS n FROM messages WHERE channel_id = ? AND import_job = ? AND ts IN (SELECT value FROM json_each(?))",
      c.id,
      job.id,
      keys,
    ),
  ])
  const imported = (results.at(-1)!.results[0] as { n: number }).n
  return {
    channel: c.id,
    imported,
    skipped: all.length - imported,
    files_needed: results.at(-2)!.results as { id: string; ts: string }[],
  }
}

/**
 * Recounts threads of a conversation from what is stored: each head (of the
 * job, its ts among `heads`) with replies gets its thread_ts, reply_count,
 * latest_reply and reply_users (repliers in order of first reply, at most 50,
 * as postMessage keeps them).
 */
export function recountThreads(
  db: D1Database,
  channelId: string,
  jobId: string,
  heads: { sql: string; params: unknown[] },
) {
  const replies =
    "FROM messages r WHERE r.channel_id = h.channel_id AND r.thread_ts = h.ts AND r.ts <> h.ts AND r.deleted = 0"
  return stmt(
    db,
    `UPDATE messages AS h SET
       thread_ts = h.ts,
       reply_count = (SELECT count(*) ${replies}),
       latest_reply = (SELECT max(r.ts) ${replies}),
       reply_users = coalesce((SELECT json_group_array(u) FROM (
         SELECT r.user_id AS u ${replies} AND r.user_id IS NOT NULL GROUP BY r.user_id ORDER BY min(r.ts) LIMIT 50)), '[]')
     WHERE h.channel_id = ? AND h.import_job = ? AND h.ts IN (${heads.sql})
       AND EXISTS (SELECT 1 ${replies})`,
    channelId,
    jobId,
    ...heads.params,
  )
}
