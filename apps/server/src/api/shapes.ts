import { all } from "../db/query"
import type { AppRow, ConversationRow, FileRow, MessageRow, ReactionRow, TeamRow, UserRow } from "../db/rows"
import type { Env } from "../env"
import { ACTIVE_WINDOW } from "./auth"
import { imagesOf, thumbsJson } from "./thumbs"

// Rows → the JSON shapes Slack's Web API returns. Fields Slack always sends
// are sent (with neutral values where Campflare has no such concept), so
// clients that read them without checking keep working.

const COLORS = ["9f69e7", "4bbe2e", "e7392d", "3c989f", "674b1b", "e96699", "e0a729", "684b6c", "5b89d5", "2b6836"]

function color(id: string) {
  let h = 0
  for (const c of id) h = (h * 31 + c.charCodeAt(0)) >>> 0
  return COLORS[h % COLORS.length]!
}

function avatar(origin: string, user: UserRow) {
  const base = `${origin}/avatars/${user.id}`
  return {
    image_24: `${base}?s=24`,
    image_32: `${base}?s=32`,
    image_48: `${base}?s=48`,
    image_72: `${base}?s=72`,
    image_192: `${base}?s=192`,
    image_512: `${base}?s=512`,
  }
}

export function teamJson(team: TeamRow, origin: string) {
  return {
    id: team.id,
    name: team.name,
    url: `${origin}/`,
    domain: team.domain,
    email_domain: "",
    icon: { image_default: true },
    avatar_base_url: `${origin}/avatars/`,
    is_verified: false,
  }
}

export function userJson(user: UserRow, origin: string) {
  const realName = user.real_name || user.name
  const [firstName = "", ...rest] = realName.split(" ")
  return {
    id: user.id,
    team_id: user.team_id,
    name: user.name,
    deleted: Boolean(user.deleted),
    color: color(user.id),
    real_name: realName,
    tz: user.tz,
    tz_label: user.tz,
    tz_offset: 0,
    profile: {
      title: user.title,
      phone: "",
      skype: "",
      real_name: realName,
      real_name_normalized: realName,
      display_name: user.display_name,
      display_name_normalized: user.display_name,
      fields: null,
      status_text: user.status_text,
      status_emoji: user.status_emoji,
      status_emoji_display_info: [],
      status_expiration: user.status_expiration,
      avatar_hash: user.id.slice(-8).toLowerCase(),
      email: user.email ?? undefined,
      first_name: firstName,
      last_name: rest.join(" "),
      ...avatar(origin, user),
      ...(user.bot_id ? { bot_id: user.bot_id, always_active: true } : {}),
      team: user.team_id,
    },
    is_admin: Boolean(user.is_admin),
    is_owner: Boolean(user.is_owner),
    is_primary_owner: Boolean(user.is_owner),
    is_restricted: false,
    is_ultra_restricted: false,
    is_bot: Boolean(user.is_bot),
    is_app_user: false,
    updated: user.updated,
    is_email_confirmed: Boolean(user.email),
    has_2fa: false,
    who_can_share_contact_card: "EVERYONE",
  }
}

export function presenceOf(user: UserRow): "active" | "away" {
  if (user.is_bot) return "active"
  if (user.manual_presence === "away") return "away"
  return Math.floor(Date.now() / 1000) - user.last_activity < ACTIVE_WINDOW ? "active" : "away"
}

export interface ConversationView {
  /** The member asking, for is_member / last_read / unread counts. */
  member?: { last_read: string } | null
  unread?: number
  numMembers?: number
  /** For an im: the other person. */
  imUser?: string
}

export function conversationJson(c: ConversationRow, view: ConversationView = {}) {
  if (c.kind === "im") {
    return {
      id: c.id,
      created: c.created,
      is_archived: Boolean(c.is_archived),
      is_im: true,
      is_org_shared: false,
      context_team_id: c.team_id,
      updated: c.updated * 1000,
      user: view.imUser ?? c.creator,
      is_user_deleted: false,
      priority: 0,
      ...readState(view),
    }
  }
  const isMpim = c.kind === "mpim"
  return {
    id: c.id,
    name: c.name,
    is_channel: !isMpim,
    is_group: isMpim,
    is_im: false,
    is_mpim: isMpim,
    is_private: isMpim || Boolean(c.is_private),
    created: c.created,
    is_archived: Boolean(c.is_archived),
    is_general: Boolean(c.is_general),
    unlinked: 0,
    name_normalized: c.name,
    is_shared: false,
    is_org_shared: false,
    is_pending_ext_shared: false,
    pending_shared: [],
    context_team_id: c.team_id,
    updated: c.updated * 1000,
    parent_conversation: null,
    creator: c.creator,
    is_ext_shared: false,
    shared_team_ids: [c.team_id],
    pending_connected_team_ids: [],
    is_member: Boolean(view.member),
    topic: { value: c.topic, creator: c.topic_creator, last_set: c.topic_last_set },
    purpose: { value: c.purpose, creator: c.purpose_creator, last_set: c.purpose_last_set },
    previous_names: JSON.parse(c.previous_names) as string[],
    ...(view.numMembers !== undefined ? { num_members: view.numMembers } : {}),
    ...readState(view),
  }
}

function readState(view: ConversationView) {
  if (!view.member) return {}
  return {
    last_read: view.member.last_read === "0000000000.000000" ? "0000000000.000000" : view.member.last_read,
    ...(view.unread !== undefined ? { unread_count: view.unread, unread_count_display: view.unread } : {}),
  }
}

const FILETYPES: Record<string, [string, string]> = {
  "image/png": ["png", "PNG"],
  "image/jpeg": ["jpg", "JPEG"],
  "image/gif": ["gif", "GIF"],
  "image/webp": ["webp", "WebP"],
  "image/svg+xml": ["svg", "SVG"],
  "application/pdf": ["pdf", "PDF"],
  "text/plain": ["text", "Plain Text"],
  "text/markdown": ["markdown", "Markdown (raw)"],
  "application/json": ["json", "JSON"],
  "application/zip": ["zip", "Zip"],
  "video/mp4": ["mp4", "MPEG 4 Video"],
  "audio/mpeg": ["mp3", "MP3"],
}

export function fileUrls(origin: string, f: Pick<FileRow, "id" | "team_id" | "name">) {
  const base = `${origin}/files-pri/${f.team_id}-${f.id}`
  return {
    url_private: `${base}/${encodeURIComponent(f.name)}`,
    url_private_download: `${base}/download/${encodeURIComponent(f.name)}`,
  }
}

/** `thumbs`: whether thumbnails are on (imagesOf(env)), so images carry thumb_*. */
export function fileJson(f: FileRow, origin: string, thumbs = false) {
  const [filetype, pretty] = FILETYPES[f.mimetype] ?? [f.name.split(".").pop()?.toLowerCase() ?? "binary", "Binary"]
  const channels = JSON.parse(f.channels) as string[]
  return {
    id: f.id,
    created: f.created,
    timestamp: f.created,
    name: f.name,
    title: f.title,
    mimetype: f.mimetype,
    filetype,
    pretty_type: pretty,
    user: f.user_id,
    user_team: f.team_id,
    editable: false,
    size: f.size,
    mode: "hosted",
    is_external: false,
    external_type: "",
    is_public: channels.some((c) => c.startsWith("C")),
    public_url_shared: false,
    display_as_bot: false,
    username: "",
    ...fileUrls(origin, f),
    permalink: `${origin}/files/${f.user_id}/${f.id}/${encodeURIComponent(f.name)}`,
    ...thumbsJson(origin, f, thumbs),
    ...(f.width && f.height ? { original_w: f.width, original_h: f.height } : {}),
    ...(f.alt_txt ? { alt_txt: f.alt_txt } : {}),
    channels: channels.filter((c) => c.startsWith("C")),
    groups: channels.filter((c) => c.startsWith("G")),
    ims: channels.filter((c) => c.startsWith("D")),
    comments_count: 0,
  }
}

export interface MessageExtras {
  reactions: Map<string, ReactionRow[]>
  files: Map<string, FileRow>
  apps: Map<string, AppRow>
  /** Whether files carry thumb_* (thumbnails are on). */
  thumbs?: boolean
  /** The messages the caller saved (`channel/ts`), for is_starred; absent when not read. */
  starred?: Set<string>
}

const key = (channelId: string, ts: string) => `${channelId}/${ts}`

/**
 * The reactions of the messages a query selects, as a statement to batch with
 * the query itself. `messages` selects (at least) channel_id and ts from
 * messages, with `params`.
 */
export function reactionsOfQuery(db: D1Database, messages: string, ...params: unknown[]) {
  return db
    .prepare(
      `SELECT * FROM reactions WHERE (channel_id, ts) IN (SELECT channel_id, ts FROM (${messages})) ORDER BY created`,
    )
    .bind(...params)
}

/**
 * Which of the messages a query selects this person saved, as a statement to
 * batch with the query itself; starredFrom() reads its result.
 */
export function starredOfQuery(db: D1Database, userId: string, messages: string, ...params: unknown[]) {
  return db
    .prepare(
      `SELECT channel_id, ts FROM stars WHERE user_id = ? AND type = 'message'
         AND (channel_id, ts) IN (SELECT channel_id, ts FROM (${messages}))`,
    )
    .bind(userId, ...params)
}

/** The keys MessageExtras.starred holds, from a starredOfQuery's result. */
export const starredFrom = (result: D1Result) =>
  new Set((result.results as { channel_id: string; ts: string }[]).map((r) => key(r.channel_id, r.ts)))

/** Reactions grouped by message, as MessageExtras holds them. */
function reactionsByMessage(rows: ReactionRow[]) {
  const byMessage = new Map<string, ReactionRow[]>()
  for (const r of rows) {
    const k = key(r.channel_id, r.ts)
    const list = byMessage.get(k) ?? []
    list.push(r)
    byMessage.set(k, list)
  }
  return byMessage
}

/** MessageExtras from what the caller already holds, for messages without files: no query. */
export function knownExtras(reactions: ReactionRow[], apps: AppRow[] = []): MessageExtras {
  return { reactions: reactionsByMessage(reactions), files: new Map(), apps: new Map(apps.map((a) => [a.bot_id, a])) }
}

/**
 * Loads what a batch of messages needs to serialise: their reactions, files and bot apps.
 * `reactions`, when the caller already has them (read in its own batch), saves that query.
 */
export async function loadExtras(env: Env, messages: MessageRow[], reactions?: ReactionRow[]): Promise<MessageExtras> {
  const extras: MessageExtras = {
    reactions: new Map(),
    files: new Map(),
    apps: new Map(),
    thumbs: Boolean(imagesOf(env)),
  }
  if (messages.length === 0) return extras
  // Ids go in as one JSON argument: D1 binds at most 100 parameters, and a page can hold 1000 messages.
  const reactionRows =
    reactions ??
    (await all<ReactionRow>(
      env.DB,
      `SELECT * FROM reactions WHERE (channel_id, ts) IN (SELECT value ->> 0, value ->> 1 FROM json_each(?)) ORDER BY created`,
      JSON.stringify(messages.map((m) => [m.channel_id, m.ts])),
    ))
  extras.reactions = reactionsByMessage(reactionRows)
  // Files and bot apps, when there are any, in parallel: two more queries but one more round trip.
  const fileIds = [...new Set(messages.flatMap((m) => (m.files ? (JSON.parse(m.files) as string[]) : [])))]
  const botIds = [...new Set(messages.flatMap((m) => (m.bot_id ? [m.bot_id] : [])))]
  const [files, apps] = await Promise.all([
    fileIds.length
      ? all<FileRow>(
          env.DB,
          "SELECT * FROM files WHERE id IN (SELECT value FROM json_each(?))",
          JSON.stringify(fileIds),
        )
      : [],
    botIds.length
      ? all<AppRow>(
          env.DB,
          "SELECT * FROM apps WHERE bot_id IN (SELECT value FROM json_each(?))",
          JSON.stringify(botIds),
        )
      : [],
  ])
  for (const f of files) extras.files.set(f.id, f)
  for (const a of apps) extras.apps.set(a.bot_id, a)
  return extras
}

export function messageJson(m: MessageRow, extras: MessageExtras, origin: string) {
  const reactions = groupReactions(extras.reactions.get(key(m.channel_id, m.ts)) ?? [])
  const fileIds = m.files ? (JSON.parse(m.files) as string[]) : []
  const files = fileIds.map((id) => {
    const f = extras.files.get(id)
    return f ? fileJson(f, origin, extras.thumbs) : { id, mode: "tombstone" }
  })
  const app = m.bot_id ? extras.apps.get(m.bot_id) : undefined
  const replyUsers = JSON.parse(m.reply_users) as string[]
  const isParent = m.thread_ts === m.ts && m.reply_count > 0
  return {
    type: "message",
    ...(m.subtype ? { subtype: m.subtype } : {}),
    ...(m.user_id ? { user: m.user_id } : {}),
    text: m.text,
    ts: m.ts,
    team: m.team_id,
    ...(m.client_msg_id ? { client_msg_id: m.client_msg_id } : {}),
    ...(m.bot_id ? { bot_id: m.bot_id } : {}),
    ...(m.app_id ? { app_id: m.app_id } : {}),
    ...(m.username ? { username: m.username } : {}),
    ...(app
      ? {
          bot_profile: {
            id: app.bot_id,
            app_id: app.id,
            name: app.name,
            icons: {},
            deleted: false,
            updated: app.created,
            team_id: app.team_id,
          },
        }
      : {}),
    ...(m.blocks ? { blocks: JSON.parse(m.blocks) } : {}),
    ...(m.attachments ? { attachments: JSON.parse(m.attachments) } : {}),
    ...(m.metadata ? { metadata: JSON.parse(m.metadata) } : {}),
    ...(files.length > 0 ? { files, upload: true, display_as_bot: false } : {}),
    ...(m.thread_ts ? { thread_ts: m.thread_ts } : {}),
    ...(m.thread_ts && m.thread_ts !== m.ts && m.parent_user_id ? { parent_user_id: m.parent_user_id } : {}),
    ...(isParent
      ? {
          reply_count: m.reply_count,
          reply_users_count: replyUsers.length,
          latest_reply: m.latest_reply,
          reply_users: replyUsers,
          is_locked: false,
          subscribed: false,
        }
      : {}),
    ...(m.edited_ts ? { edited: { user: m.edited_user, ts: m.edited_ts } } : {}),
    ...(reactions.length > 0 ? { reactions } : {}),
    ...(m.stream_state ? { streaming_state: m.stream_state } : {}),
    // A message is pinned only to its own conversation.
    ...(m.pinned_at ? { pinned_to: [m.channel_id] } : {}),
    ...(extras.starred?.has(key(m.channel_id, m.ts)) ? { is_starred: true } : {}),
  }
}

function groupReactions(rows: ReactionRow[]) {
  const byName = new Map<string, string[]>()
  for (const r of rows) byName.set(r.name, [...(byName.get(r.name) ?? []), r.user_id])
  return [...byName].map(([name, users]) => ({ name, users, count: users.length }))
}

export function permalink(origin: string, channelId: string, ts: string, threadTs?: string | null) {
  const base = `${origin}/archives/${channelId}/p${ts.replace(".", "")}`
  return threadTs && threadTs !== ts ? `${base}?thread_ts=${threadTs}&cid=${channelId}` : base
}
