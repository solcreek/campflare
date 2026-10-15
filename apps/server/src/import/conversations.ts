import type { Actor, Ctx } from "../api/context"
import { invalidArguments } from "../api/errors"
import { ids, nowSeconds, randomId } from "../api/ids"
import { stmt } from "../db/query"
import { bump, limitExceeded, LIMITS, loadJob, type JobOptions } from "./job"
import { candidates, channelNameFrom, SYSTEM_USER_ID } from "./text"

// campflare.import.conversations: channels, private channels, group DMs and
// DMs, mapped to new or existing conversations (docs/import.md, Mapping).

export interface ExportConversation {
  id: string
  /** channel (channels.json), group (groups.json), mpim (mpims.json) or im (dms.json). */
  type: "channel" | "group" | "mpim" | "im"
  name?: string
  created?: number
  creator?: string
  is_archived?: boolean
  is_general?: boolean
  members?: string[]
  topic?: { value?: string; creator?: string; last_set?: number }
  purpose?: { value?: string; creator?: string; last_set?: number }
}

type Action = "created" | "renamed" | "merged" | "skipped" | "known"

const TYPES = new Set(["channel", "group", "mpim", "im"])

interface NewConversation {
  id: string
  kind: "channel" | "im" | "mpim"
  name: string
  is_private: number
  is_archived: number
  creator: string
  topic: string
  topic_creator: string
  topic_last_set: number
  purpose: string
  purpose_creator: string
  purpose_last_set: number
  member_key: string | null
  created: number
}

export async function importConversations(ctx: Ctx<Actor>) {
  const job = await loadJob(ctx, { running: true })
  const options = JSON.parse(job.options) as JobOptions
  const list = ctx.args.json<ExportConversation[]>("conversations")
  if (!Array.isArray(list)) throw invalidArguments("conversations must be a JSON array")
  if (list.length > LIMITS.conversations) throw limitExceeded("conversations", LIMITS.conversations)
  for (const c of list) {
    if (!c || typeof c.id !== "string" || !c.id || !TYPES.has(c.type)) {
      throw invalidArguments("each conversation needs an id and a type: channel, group, mpim or im")
    }
  }
  const db = ctx.env.DB
  const team = ctx.auth.team.id
  const people = [
    ...new Set(
      list.flatMap((c) => [...(c.members ?? []), c.creator ?? "", c.topic?.creator ?? "", c.purpose?.creator ?? ""]),
    ),
  ].filter(Boolean)
  const names = list.flatMap((c) =>
    c.type === "channel" || c.type === "group" ? candidates(channelNameFrom(c.name || c.id)) : [],
  )
  const [known, users, channels, general] = await db.batch([
    stmt(
      db,
      `SELECT source_id, conversation_id, action FROM import_conversations
       WHERE job_id = ? AND source_id IN (SELECT value FROM json_each(?))`,
      job.id,
      JSON.stringify(list.map((c) => c.id)),
    ),
    stmt(
      db,
      "SELECT source_id, user_id FROM import_users WHERE job_id = ? AND source_id IN (SELECT value FROM json_each(?))",
      job.id,
      JSON.stringify(people),
    ),
    stmt(
      db,
      `SELECT id, name, is_private FROM conversations
       WHERE team_id = ? AND kind = 'channel' AND name IN (SELECT value FROM json_each(?))`,
      team,
      JSON.stringify(names),
    ),
    stmt(db, "SELECT id FROM conversations WHERE team_id = ? AND is_general = 1", team),
  ])
  const done = new Map(
    (known!.results as { source_id: string; conversation_id: string }[]).map((r) => [r.source_id, r.conversation_id]),
  )
  const userOf = new Map(
    (users!.results as { source_id: string; user_id: string }[]).map((r) => [r.source_id, r.user_id]),
  )
  const channelByName = new Map(
    (channels!.results as { id: string; name: string; is_private: number }[]).map((r) => [r.name, r]),
  )
  const generalId = (general!.results[0] as { id: string } | undefined)?.id

  // DMs and group DMs go into the existing one with the same people: read those in one more query.
  const memberKeys = new Map<string, string>()
  for (const c of list) {
    if (done.has(c.id) || (c.type !== "im" && c.type !== "mpim")) continue
    const members = (c.members ?? []).map((m) => userOf.get(m))
    // Someone not in users.json, or the source's system user (Slackbot), which is no one here: skipped.
    if (members.length === 0 || members.some((m) => !m || m === SYSTEM_USER_ID)) continue
    memberKeys.set(c.id, [...new Set(members as string[])].toSorted().join(","))
  }
  const byKey = new Map<string, string>()
  if (memberKeys.size) {
    const rows = await db
      .prepare(
        "SELECT id, member_key FROM conversations WHERE team_id = ? AND member_key IN (SELECT value FROM json_each(?))",
      )
      .bind(team, JSON.stringify([...memberKeys.values()]))
      .all<{ id: string; member_key: string }>()
    for (const r of rows.results) byKey.set(r.member_key, r.id)
  }

  const now = nowSeconds()
  const out: { source_id: string; conversation_id: string | null; action: Action; name?: string }[] = []
  const created: NewConversation[] = []
  const mappings: [string, string, Action][] = []
  const members: [string, string][] = []
  const counts = { created: 0, renamed: 0, merged: 0, skipped: 0 }
  for (const c of list) {
    const already = done.get(c.id)
    if (already) {
      out.push({ source_id: c.id, conversation_id: already, action: "known" })
      continue
    }
    // The system user is never a member or a creator: it has no row in users.
    const mapped = (id?: string) => {
      const user = id ? userOf.get(id) : undefined
      return user === SYSTEM_USER_ID ? undefined : user
    }
    const creator = mapped(c.creator) ?? ctx.auth.user.id
    let target: string | undefined
    let action: Action
    let name: string | undefined
    if (c.type === "im" || c.type === "mpim") {
      const key = memberKeys.get(c.id)
      if (!key) {
        // Someone in it isn't anyone here: there's no one to give it to.
        counts.skipped++
        out.push({ source_id: c.id, conversation_id: null, action: "skipped" })
        continue
      }
      target = byKey.get(key)
      action = target ? "merged" : "created"
      if (!target) {
        target = c.type === "im" ? ids.im() : ids.mpim()
        byKey.set(key, target)
        const everyone = key.split(",")
        name = c.type === "im" ? (everyone.find((u) => u !== creator) ?? everyone[0]!) : channelNameFrom(c.name || c.id)
        created.push(newConversation(c, target, c.type, name, creator, key))
      }
    } else {
      const base = channelNameFrom(c.name || c.id)
      const isPrivate = c.type === "group" ? 1 : 0
      const existing = c.is_general && generalId ? { id: generalId, is_private: 0 } : channelByName.get(base)
      // Merged only into one as private as it was: never a private channel's history into a public one, nor back.
      if (existing && options.merge_into_existing && existing.is_private === isPrivate) {
        target = existing.id
        action = "merged"
      } else {
        name = candidates(base).find((n) => !channelByName.has(n)) ?? `${base}-${randomId("", 4).toLowerCase()}`
        action = name === base ? "created" : "renamed"
        target = ids.channel()
        channelByName.set(name, { id: target, name, is_private: isPrivate })
        created.push(newConversation(c, target, "channel", name, creator, null))
      }
    }
    counts[action]++
    mappings.push([c.id, target, action])
    for (const m of new Set(c.type === "im" || c.type === "mpim" ? memberKeys.get(c.id)!.split(",") : c.members)) {
      const user = c.type === "im" || c.type === "mpim" ? m : mapped(m)
      if (user) members.push([target, user])
    }
    out.push({ source_id: c.id, conversation_id: target, action, ...(name ? { name } : {}) })
  }

  if (mappings.length) {
    await db.batch([
      ...(created.length
        ? [
            stmt(
              db,
              `INSERT INTO conversations (id, team_id, kind, name, is_private, is_archived, creator, topic, topic_creator,
                 topic_last_set, purpose, purpose_creator, purpose_last_set, member_key, created, updated, import_job)
               SELECT value ->> 'id', ?1, value ->> 'kind', value ->> 'name', value ->> 'is_private',
                 value ->> 'is_archived', value ->> 'creator', value ->> 'topic', value ->> 'topic_creator',
                 value ->> 'topic_last_set', value ->> 'purpose', value ->> 'purpose_creator',
                 value ->> 'purpose_last_set', value ->> 'member_key', value ->> 'created', ?2, ?3
               FROM json_each(?4)`,
              team,
              now,
              job.id,
              JSON.stringify(created),
            ),
          ]
        : []),
      // Only memberships it adds carry the job: undo leaves those that were there.
      stmt(
        db,
        `INSERT OR IGNORE INTO members (conversation_id, user_id, joined, import_job)
         SELECT value ->> 0, value ->> 1, ?, ? FROM json_each(?)`,
        now,
        job.id,
        JSON.stringify(members),
      ),
      stmt(
        db,
        `INSERT OR IGNORE INTO import_conversations (job_id, source_id, conversation_id, action)
         SELECT ?, value ->> 0, value ->> 1, value ->> 2 FROM json_each(?)`,
        job.id,
        JSON.stringify(mappings),
      ),
      bump(db, job.id, {
        conversations_created: counts.created,
        conversations_renamed: counts.renamed,
        conversations_merged: counts.merged,
        conversations_skipped: counts.skipped,
      }),
    ])
  } else if (counts.skipped) {
    await bump(db, job.id, { conversations_skipped: counts.skipped }).run()
  }
  return { conversations: out }

  function newConversation(
    c: ExportConversation,
    id: string,
    kind: NewConversation["kind"],
    name: string,
    creator: string,
    memberKey: string | null,
  ): NewConversation {
    return {
      id,
      kind,
      name,
      is_private: c.type === "channel" ? 0 : 1,
      is_archived: c.is_archived ? 1 : 0,
      creator,
      topic: (c.topic?.value ?? "").slice(0, 250),
      topic_creator: (c.topic?.creator && userOf.get(c.topic.creator)) || "",
      topic_last_set: c.topic?.last_set ?? 0,
      purpose: (c.purpose?.value ?? "").slice(0, 250),
      purpose_creator: (c.purpose?.creator && userOf.get(c.purpose.creator)) || "",
      purpose_last_set: c.purpose?.last_set ?? 0,
      member_key: memberKey,
      created: typeof c.created === "number" ? c.created : now,
    }
  }
}
