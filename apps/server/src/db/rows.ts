// Row shapes, as D1 returns them (0/1 for booleans).

export interface TeamRow {
  id: string
  name: string
  domain: string
  created: number
}

export interface UserRow {
  id: string
  team_id: string
  name: string
  real_name: string
  display_name: string
  email: string | null
  title: string
  status_text: string
  status_emoji: string
  status_expiration: number
  tz: string
  is_admin: number
  is_owner: number
  is_bot: number
  bot_id: string | null
  deleted: number
  manual_presence: string
  last_activity: number
  snooze_until: number
  updated: number
  created: number
}

export interface AppRow {
  id: string
  team_id: string
  name: string
  bot_id: string
  bot_user_id: string
  installer_user_id: string
  created: number
  /** Signs Events API deliveries (migration 0009). */
  signing_secret: string
  /** Where the Events API POSTs, once verified; NULL for none. */
  event_request_url: string | null
  /** JSON array of subscribed event types; NULL for all. */
  event_types: string | null
  /** Where clicks on the app's buttons are POSTed (migration 0013); NULL for none. */
  interactivity_request_url: string | null
  /** When HTTP event delivery was turned off for failing (migration 0015), in seconds; NULL while on. */
  event_delivery_disabled_at: number | null
  /** Why it was turned off. */
  event_delivery_disabled_reason: string | null
}

export interface TokenRow {
  hash: string
  team_id: string
  kind: "user" | "bot" | "app"
  user_id: string | null
  app_id: string | null
  scopes: string
  expires: number | null
  label: string
  /** The OAuth client it was issued to by oauth.v2.access, if any. */
  client_id: string | null
  created: number
  revoked: number
}

export interface ConversationRow {
  id: string
  team_id: string
  kind: "channel" | "im" | "mpim"
  name: string
  is_private: number
  is_general: number
  is_archived: number
  creator: string
  topic: string
  topic_creator: string
  topic_last_set: number
  purpose: string
  purpose_creator: string
  purpose_last_set: number
  previous_names: string
  member_key: string | null
  created: number
  updated: number
}

export interface MemberRow {
  conversation_id: string
  user_id: string
  last_read: string
  joined: number
}

export interface MessageRow {
  channel_id: string
  ts: string
  team_id: string
  user_id: string | null
  bot_id: string | null
  app_id: string | null
  username: string | null
  subtype: string | null
  text: string
  blocks: string | null
  attachments: string | null
  metadata: string | null
  files: string | null
  thread_ts: string | null
  parent_user_id: string | null
  reply_count: number
  reply_users: string
  latest_reply: string | null
  edited_ts: string | null
  edited_user: string | null
  client_msg_id: string | null
  deleted: number
  /** A streamed message's state: "in_progress" or "completed"; null for an ordinary message. */
  stream_state: string | null
  /** How the stream sends content, "markdown_text" or "chunks", once it has sent any. */
  stream_mode: string | null
  /** The person who stopped the stream from their client (campflare.chat.stopStream); null otherwise. */
  stream_stopped_by: string | null
  /** chat.startStream's task_display_mode when it's "plan"; null for the default timeline. */
  stream_task_display: string | null
}

export interface ReactionRow {
  channel_id: string
  ts: string
  name: string
  user_id: string
  created: number
}

export interface FileRow {
  id: string
  team_id: string
  user_id: string
  name: string
  title: string
  mimetype: string
  size: number
  width: number | null
  height: number | null
  /** 1 for an animated GIF or WebP, 0 for other images; NULL for other files and images uploaded before migration 0014. */
  animated: number | null
  alt_txt: string | null
  status: "reserved" | "uploaded" | "complete"
  channels: string
  created: number
}

export type ActivityKind = "mention" | "dm" | "thread_reply" | "reaction"

/** An activity item (migration 0019, docs/activity.md). */
export interface ActivityRow {
  id: number
  team_id: string
  user_id: string
  kind: ActivityKind
  channel_id: string
  ts: string
  thread_ts: string | null
  /** Who did it; '' when unknown. */
  actor_id: string
  /** The emoji, for a reaction; '' otherwise. */
  reaction: string
  created: number
  notify: number
  /** When it was read (epoch seconds), 0 while unread. */
  read: number
}

export type NotificationLevel = "all" | "mentions" | "none"

export interface NotificationPrefRow {
  user_id: string
  /** '' for the person's default. */
  conversation_id: string
  level: NotificationLevel
  updated: number
}
