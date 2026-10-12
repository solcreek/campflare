import { all } from "../db/query"
import type { UserRow } from "../db/rows"
import type { Caller } from "./invoke"

// Compact shapes for agents: names instead of ids where it helps reading, ids
// kept where the agent needs them for the next call (ts, conversation ids).

export interface Directory {
  /** "@handle" for a user id, or the id when unknown. */
  name(id: string | undefined): string
}

export async function directory(caller: Caller): Promise<Directory> {
  const users = await all<Pick<UserRow, "id" | "name">>(
    caller.env.DB,
    "SELECT id, name FROM users WHERE team_id = ?",
    caller.auth.team.id,
  )
  const names = new Map(users.map((u) => [u.id, u.name]))
  return { name: (id) => (id ? (names.has(id) ? `@${names.get(id)}` : id) : "unknown") }
}

export interface RawMessage {
  ts: string
  user?: string
  username?: string
  text?: string
  subtype?: string
  thread_ts?: string
  reply_count?: number
  reactions?: { name: string; count: number }[]
  files?: { name?: string; id: string }[]
  bot_profile?: { name?: string }
  edited?: unknown
}

/** Who wrote a message: a bot by its name, a person by "@handle", else a custom username. */
export function author(m: RawMessage, dir: Directory): string {
  if (m.bot_profile?.name) return m.username || m.bot_profile.name
  if (m.user) return dir.name(m.user)
  return m.username || "unknown"
}

export function compactMessage(m: RawMessage, dir: Directory) {
  return {
    ts: m.ts,
    from: author(m, dir),
    text: m.text ?? "",
    ...(m.subtype ? { subtype: m.subtype } : {}),
    ...(m.thread_ts && m.thread_ts !== m.ts ? { thread_ts: m.thread_ts } : {}),
    ...(m.reply_count ? { replies: m.reply_count } : {}),
    ...(m.reactions?.length ? { reactions: m.reactions.map((r) => `:${r.name}: ${r.count}`) } : {}),
    ...(m.files?.length ? { files: m.files.map((f) => f.name ?? f.id) } : {}),
    ...(m.edited ? { edited: true } : {}),
  }
}

/** A tool result: JSON text for the model, and the same value as structured content. */
export function result(value: Record<string, unknown>) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }], structuredContent: value }
}
