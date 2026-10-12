import { all, first } from "../db/query"
import type { ConversationRow, MessageRow, UserRow } from "../db/rows"
import { method, type Actor, type Ctx } from "../api/context"
import { microsToTs } from "../api/ids"
import { ftsString, indexable, likePattern, parseSearch } from "../api/search-query"
import { loadExtras, messageJson, permalink } from "../api/shapes"

/** Subtypes that are conversation content; joins, topic changes and the like aren't searched. */
const CONTENT = "(m.subtype IS NULL OR m.subtype IN ('bot_message', 'me_message', 'thread_broadcast', 'file_share'))"

async function resolveUsers(ctx: Ctx<Actor>, refs: string[]): Promise<string[]> {
  const out: string[] = []
  for (const ref of refs) {
    const v = ref.replace(/^<@([A-Z0-9]+)(\|[^>]*)?>$/, "$1").replace(/^@/, "")
    if (v === "me") {
      out.push(ctx.auth.user.id)
      continue
    }
    const user = await first<UserRow>(
      ctx.env.DB,
      `SELECT * FROM users WHERE team_id = ? AND (id = ? OR lower(name) = lower(?) OR lower(display_name) = lower(?))`,
      ctx.auth.team.id,
      v,
      v,
      v,
    )
    out.push(user?.id ?? "-") // an unknown name matches nothing, as in Slack
  }
  return out
}

async function resolveChannels(ctx: Ctx<Actor>, refs: string[]): Promise<string[]> {
  const out: string[] = []
  for (const ref of refs) {
    const v = ref.replace(/^<#([A-Z0-9]+)(\|[^>]*)?>$/, "$1")
    if (v.startsWith("@") || v.startsWith("<@")) {
      // in:@person — your DM with them.
      const [userId] = await resolveUsers(ctx, [v])
      const key = [ctx.auth.user.id, userId].toSorted().join(",")
      const dm = await first<ConversationRow>(
        ctx.env.DB,
        "SELECT * FROM conversations WHERE team_id = ? AND member_key = ?",
        ctx.auth.team.id,
        userId === ctx.auth.user.id ? ctx.auth.user.id : key,
      )
      out.push(dm?.id ?? "-")
      continue
    }
    const name = v.replace(/^#/, "").toLowerCase()
    const c = await first<ConversationRow>(
      ctx.env.DB,
      "SELECT * FROM conversations WHERE team_id = ? AND (id = ? OR (kind != 'im' AND name = ?))",
      ctx.auth.team.id,
      v,
      name,
    )
    out.push(c?.id ?? "-")
  }
  return out
}

const tsOf = (seconds: number) => microsToTs(Math.round(seconds * 1_000_000))

method("search.messages", "user", async (ctx) => {
  const query = ctx.args.req("query", "no_query")
  const count = ctx.args.int("count", 20, { min: 1, max: 100 })
  const page = ctx.args.int("page", 1, { min: 1, max: 100 })
  const byScore = (ctx.args.str("sort") ?? "score") === "score"
  const asc = ctx.args.str("sort_dir") === "asc"
  const q = parseSearch(query)

  const where = [
    "m.team_id = ?",
    "m.deleted = 0",
    CONTENT,
    "(mem.user_id IS NOT NULL OR (c.kind = 'channel' AND c.is_private = 0))",
  ]
  const params: unknown[] = [ctx.auth.team.id]
  const fts = q.terms.filter(indexable)
  for (const term of q.terms.filter((t) => !indexable(t))) {
    where.push("m.text LIKE ? ESCAPE '\\'")
    params.push(likePattern(term))
  }
  for (const term of q.excluded) {
    where.push("m.text NOT LIKE ? ESCAPE '\\'")
    params.push(likePattern(term))
  }
  if (q.from.length) {
    const users = await resolveUsers(ctx, q.from)
    where.push(`m.user_id IN (${users.map(() => "?").join(", ")})`)
    params.push(...users)
  }
  if (q.in.length) {
    const channels = await resolveChannels(ctx, q.in)
    where.push(`m.channel_id IN (${channels.map(() => "?").join(", ")})`)
    params.push(...channels)
  }
  if (q.since !== undefined) {
    where.push("m.ts >= ?")
    params.push(tsOf(q.since))
  }
  if (q.until !== undefined) {
    where.push("m.ts < ?")
    params.push(tsOf(q.until))
  }
  for (const has of q.has.map((h) => h.toLowerCase())) {
    if (has === "link") where.push("(m.text LIKE '%<http%' OR m.text LIKE '%http://%' OR m.text LIKE '%https://%')")
    else if (has === "reaction" || has === ":reaction:")
      where.push("EXISTS (SELECT 1 FROM reactions r WHERE r.channel_id = m.channel_id AND r.ts = m.ts)")
    else if (has === "file" || has === "attachment") where.push("m.files IS NOT NULL")
    else where.push("0")
  }
  for (const is of q.is.map((i) => i.toLowerCase())) {
    if (is === "thread") where.push("m.thread_ts IS NOT NULL")
    else if (is === "dm") where.push("c.kind IN ('im', 'mpim')")
  }

  const from = fts.length ? "messages_fts JOIN messages m ON m.rowid = messages_fts.rowid" : "messages m"
  if (fts.length) {
    where.unshift("messages_fts MATCH ?")
    params.unshift(fts.map(ftsString).join(" AND "))
  }
  const joins = `JOIN conversations c ON c.id = m.channel_id
    LEFT JOIN members mem ON mem.conversation_id = c.id AND mem.user_id = ?`
  // The join's user comes first in the text, then the WHERE clause's.
  const ordered = [ctx.auth.user.id, ...params]
  const sql = `FROM ${from} ${joins} WHERE ${where.join(" AND ")}`
  const order = byScore && fts.length ? "bm25(messages_fts), m.ts DESC" : `m.ts ${asc ? "ASC" : "DESC"}`

  const total = (await first<{ n: number }>(ctx.env.DB, `SELECT COUNT(*) AS n ${sql}`, ...ordered))?.n ?? 0
  const rows = await all<
    MessageRow & { c_name: string; c_kind: ConversationRow["kind"]; c_private: number; c_key: string | null }
  >(
    ctx.env.DB,
    `SELECT m.*, c.name AS c_name, c.kind AS c_kind, c.is_private AS c_private, c.member_key AS c_key
     ${sql} ORDER BY ${order} LIMIT ? OFFSET ?`,
    ...ordered,
    count,
    (page - 1) * count,
  )
  const users = new Map<string, UserRow>()
  const authorIds = [...new Set(rows.flatMap((r) => (r.user_id ? [r.user_id] : [])))]
  if (authorIds.length) {
    for (const u of await all<UserRow>(
      ctx.env.DB,
      `SELECT * FROM users WHERE id IN (${authorIds.map(() => "?").join(", ")})`,
      ...authorIds,
    )) {
      users.set(u.id, u)
    }
  }
  const extras = await loadExtras(ctx.env, rows)
  const pages = Math.max(1, Math.ceil(total / count))
  const matches = rows.map((m, i) => {
    const json = messageJson(m, extras, ctx.origin)
    const imPeer =
      m.c_kind === "im" ? (m.c_key?.split(",").find((u) => u !== ctx.auth.user.id) ?? ctx.auth.user.id) : undefined
    return {
      iid: `${m.channel_id}-${m.ts}`,
      team: m.team_id,
      score: byScore ? total - ((page - 1) * count + i) : 0,
      channel: {
        id: m.channel_id,
        is_channel: m.c_kind === "channel",
        is_group: m.c_kind === "mpim",
        is_im: m.c_kind === "im",
        is_mpim: m.c_kind === "mpim",
        is_private: m.c_kind !== "channel" || Boolean(m.c_private),
        is_shared: false,
        is_org_shared: false,
        is_ext_shared: false,
        is_pending_ext_shared: false,
        pending_shared: [],
        name: imPeer ?? m.c_name,
        ...(imPeer ? { user: imPeer } : {}),
      },
      type: "message",
      user: m.user_id ?? "",
      username: (m.user_id && users.get(m.user_id)?.name) || m.username || "",
      ts: m.ts,
      text: m.text,
      permalink: permalink(ctx.origin, m.channel_id, m.ts, m.thread_ts),
      ...("blocks" in json ? { blocks: json.blocks } : {}),
      ...("files" in json ? { files: json.files } : {}),
      no_reactions: !("reactions" in json),
    }
  })
  return {
    query,
    messages: {
      total,
      pagination: {
        total_count: total,
        page,
        per_page: count,
        page_count: pages,
        first: total ? (page - 1) * count + 1 : 0,
        last: (page - 1) * count + matches.length,
      },
      paging: { count, total, page, pages },
      matches,
    },
  }
})
