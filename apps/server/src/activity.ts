import { stmt } from "./db/query"
import type { ActivityKind, ActivityRow, ConversationRow, MessageRow } from "./db/rows"
import type { PublishInput } from "./hub"
import { nowSeconds } from "./api/ids"
import { permalink } from "./api/shapes"

// The activity inbox (docs/activity.md): what happened to each person, written
// in the same batch as the message or reaction behind it.

export const ACTIVITY_KINDS: readonly ActivityKind[] = ["mention", "dm", "thread_reply", "reaction"]

/** Message subtypes that are someone saying something new: what makes items. */
const SAYING = new Set<string | null>([null, "thread_broadcast", "file_share", "bot_message", "me_message"])

/** `<@U123>` or `<@U123|name>`. */
const USER_MENTION = /<@([UW][A-Z0-9]+)(?:\|[^>]*)?>/g

/** `<!here>`, `<!channel>`, `<!everyone>`, with or without a label. */
const BROADCAST = /<!(?:here|channel|everyone)(?:\|[^>]*)?>/

/** Whom a message's text mentions: user ids, and whether it reaches every member. */
export function mentionsOf(text: string): { users: string[]; everyone: boolean } {
  return { users: [...new Set([...text.matchAll(USER_MENTION)].map((m) => m[1]!))], everyone: BROADCAST.test(text) }
}

/**
 * Whether an item notifies, as SQL over the recipient `r` (user_id, kind), their
 * user row `u` and their levels `pc` (the conversation's) and `pd` (default):
 * not while snoozed; `all` lets everything through, `mentions` mentions and DMs.
 * `now` is the parameter holding the time, in seconds.
 */
const notify = (now: string) => `(u.snooze_until <= ${now} AND CASE COALESCE(pc.level, pd.level, 'all')
  WHEN 'all' THEN 1 WHEN 'mentions' THEN r.kind IN ('mention', 'dm') ELSE 0 END)`

/** The recipients `r` joined to what notify() reads; `?2` is the conversation. */
const RECIPIENTS = `JOIN users u ON u.id = r.user_id AND u.deleted = 0
  LEFT JOIN notification_prefs pc ON pc.user_id = r.user_id AND pc.conversation_id = ?2
  LEFT JOIN notification_prefs pd ON pd.user_id = r.user_id AND pd.conversation_id = ''`

/** A reply's thread, or null for a message outside one (a thread's head included). */
const threadOf = (m: Pick<MessageRow, "ts" | "thread_ts">) => (m.thread_ts && m.thread_ts !== m.ts ? m.thread_ts : null)

/**
 * Who takes part in a thread (`?4` in conversation `?2`): everyone who wrote in
 * it, deleted replies included (they followed it), and its head's author as
 * every reply recorded it (`parent_user_id`), which survives the head being
 * tombstoned. Two range scans of the thread index.
 */
const PARTICIPANTS = `SELECT user_id FROM messages WHERE channel_id = ?2 AND thread_ts = ?4
  UNION SELECT parent_user_id FROM messages WHERE channel_id = ?2 AND thread_ts = ?4`

/**
 * The items a new message makes, as one INSERT … RETURNING to batch with the
 * message itself; undefined when it can make none (most channel messages).
 * Recipients are the conversation's members other than the author, each once,
 * with the strongest kind: mention, then dm, then thread_reply. Only a
 * broadcast or a DM reads every member; otherwise the members are looked up
 * by the candidates alone (those named, the thread's participants).
 */
export function messageActivity(
  db: D1Database,
  c: Pick<ConversationRow, "id" | "team_id" | "kind">,
  m: Pick<MessageRow, "ts" | "thread_ts" | "user_id" | "subtype" | "text">,
): D1PreparedStatement | undefined {
  if (!SAYING.has(m.subtype)) return undefined
  const { users, everyone } = mentionsOf(m.text)
  const dm = c.kind === "im" || c.kind === "mpim"
  const thread = threadOf(m)
  if (!dm && !thread && !everyone && users.length === 0) return undefined
  // User groups (<!subteam^S…>) would add their members to ?6 here, in SQL: see docs/activity.md.
  const named = "m.user_id IN (SELECT value FROM json_each(?6))"
  // A broadcast makes everyone's a mention, and a DM makes no thread_reply: either way no thread to read.
  const [kind, who] = everyone
    ? ["'mention'", ""]
    : dm
      ? [`CASE WHEN ${named} THEN 'mention' ELSE 'dm' END`, ""]
      : [
          `CASE WHEN ${named} THEN 'mention' ELSE 'thread_reply' END`,
          `AND m.user_id IN (SELECT value FROM json_each(?6)${thread ? ` UNION ${PARTICIPANTS}` : ""})`,
        ]
  return stmt(
    db,
    `INSERT INTO activity (team_id, user_id, kind, channel_id, ts, thread_ts, actor_id, created, notify)
     SELECT ?1, r.user_id, r.kind, ?2, ?3, ?4, COALESCE(?5, ''), ?7, ${notify("?7")}
     FROM (
       SELECT m.user_id, ${kind} AS kind
       FROM members m WHERE m.conversation_id = ?2 AND m.user_id IS NOT ?5 ${who}
     ) r
     ${RECIPIENTS}
     RETURNING *`,
    c.team_id,
    c.id,
    m.ts,
    thread,
    m.user_id,
    JSON.stringify(users),
    nowSeconds(),
  )
}

/**
 * The item a reaction makes for the message's author, as a statement to batch
 * after the reaction's INSERT: only if that inserted it, and the author is a
 * member and not the one reacting.
 */
export function reactionActivity(
  db: D1Database,
  c: Pick<ConversationRow, "id" | "team_id">,
  m: Pick<MessageRow, "ts" | "thread_ts" | "user_id">,
  name: string,
  reactor: string,
): D1PreparedStatement | undefined {
  if (!m.user_id || m.user_id === reactor) return undefined
  return stmt(
    db,
    `INSERT INTO activity (team_id, user_id, kind, channel_id, ts, thread_ts, actor_id, reaction, created, notify)
     SELECT ?1, r.user_id, r.kind, ?2, ?3, ?4, ?5, ?6, ?8, ${notify("?8")}
     FROM (
       SELECT m.user_id, 'reaction' AS kind FROM members m
       WHERE m.conversation_id = ?2 AND m.user_id = ?7
         AND EXISTS (SELECT 1 FROM reactions WHERE channel_id = ?2 AND ts = ?3 AND name = ?6 AND user_id = ?5)
     ) r
     ${RECIPIENTS}
     RETURNING *`,
    c.team_id,
    c.id,
    m.ts,
    threadOf(m),
    reactor,
    name,
    m.user_id,
    nowSeconds(),
  )
}

/** Removes a message's items (its reactions' included), returning whose they were. */
export const messageActivityGone = (db: D1Database, channelId: string, ts: string) =>
  stmt(db, "DELETE FROM activity WHERE channel_id = ? AND ts = ? RETURNING id, user_id", channelId, ts)

/** Removes a reaction's item, returning whose it was. */
export const reactionActivityGone = (db: D1Database, channelId: string, ts: string, name: string, reactor: string) =>
  stmt(
    db,
    `DELETE FROM activity WHERE channel_id = ? AND ts = ? AND kind = 'reaction' AND actor_id = ? AND reaction = ?
     RETURNING id, user_id`,
    channelId,
    ts,
    reactor,
    name,
  )

/** An item as the API answers it; `message` when the caller has it. */
export function activityJson(row: ActivityRow, origin: string, message?: unknown) {
  return {
    id: String(row.id),
    type: row.kind,
    channel: row.channel_id,
    ts: row.ts,
    ...(row.thread_ts ? { thread_ts: row.thread_ts } : {}),
    ...(row.actor_id ? { actor: row.actor_id } : {}),
    ...(row.reaction ? { reaction: row.reaction } : {}),
    created: row.created,
    is_read: Boolean(row.read),
    notify: Boolean(row.notify),
    ...(message ? { message } : {}),
    permalink: permalink(origin, row.channel_id, row.ts, row.thread_ts),
  }
}

/** RTM activity_added for each new item, to its recipient alone: to send right after what made them. */
export function activityAdded(origin: string, teamId: string, result: D1Result | undefined, message: unknown) {
  return ((result?.results ?? []) as ActivityRow[]).map((row): PublishInput => ({
    teamId,
    audience: [row.user_id],
    rtmOnly: true,
    event: { type: "activity_added", item: activityJson(row, origin, message) },
  }))
}

/** RTM activity_removed for the items a delete returned, one per recipient with their ids. */
export function activityRemoved(teamId: string, result: D1Result | undefined) {
  const byUser = new Map<string, string[]>()
  for (const r of (result?.results ?? []) as Pick<ActivityRow, "id" | "user_id">[]) {
    byUser.set(r.user_id, [...(byUser.get(r.user_id) ?? []), String(r.id)])
  }
  return [...byUser].map(([user, ids]): PublishInput => ({
    teamId,
    audience: [user],
    rtmOnly: true,
    event: { type: "activity_removed", ids },
  }))
}
