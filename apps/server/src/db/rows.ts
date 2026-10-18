// Row shapes, as D1 returns them (0/1 for booleans).

export interface TeamRow {
  id: string
  name: string
  domain: string
  created: number
  /** When the workspace's custom emoji last changed, in epoch milliseconds (emoji.list's cache_ts). */
  emoji_updated: number
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
  /** DND hours (migration 0027): "22:00", "08:00", "mon,tue,…"; '' when unset. */
  dnd_start: string
  dnd_end: string
  dnd_days: string
  /** The DND window in progress or next (epoch seconds), 0 without a schedule; the Scheduler moves it on. */
  dnd_window_start: number
  dnd_window_end: number
  /** When dnd.endDnd was last called: the window in progress then is skipped. 0: never. */
  dnd_skipped_at: number
  /** The origin of the request that set the status (migration 0027), for the user_change when it expires. */
  status_origin: string | null
  /** The profile photo's id (migration 0021), or null: the initials are drawn instead. */
  photo: string | null
  photo_type: string | null
  /** users.setPhoto's crop square, as JSON {x, y, w}, or null. */
  photo_crop: string | null
  updated: number
  created: number
}

export interface UsergroupRow {
  id: string
  team_id: string
  handle: string
  name: string
  description: string
  /** JSON array of channel ids: prefs.channels. */
  channels: string
  created_by: string
  updated_by: string
  deleted_by: string | null
  date_create: number
  date_update: number
  date_delete: number
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
  /** Set on an app the server itself acts as (migration 0023): "campflare" for the built-in bot. */
  built_in?: string | null
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
  /** Who pinned it to its conversation (migration 0022); null when it isn't pinned. */
  pinned_by: string | null
  /** When it was pinned, in seconds; null when it isn't. */
  pinned_at: number | null
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

/** A message waiting to be posted (chat.scheduleMessage, migration 0023). */
export interface ScheduledMessageRow {
  id: string
  team_id: string
  channel_id: string
  user_id: string
  app_id: string | null
  username: string | null
  text: string
  blocks: string | null
  attachments: string | null
  metadata: string | null
  thread_ts: string | null
  reply_broadcast: number
  post_at: number
  created: number
  origin: string
  /** The scheduling token's scopes, as it held them: what posting checks at fire time. */
  scopes: string
  claimed_until: number | null
  /** The claiming runner's token while claimed: its post only commits while the row still holds it. */
  claim: string | null
  attempts: number
}

/** reminders.add (migration 0023). */
export interface ReminderRow {
  id: string
  team_id: string
  creator_id: string
  user_id: string
  text: string
  time: number
  complete_ts: number
  fired: number
  created: number
  origin: string
  claimed_until: number | null
  claim: string | null
  attempts: number
}

export interface BookmarkRow {
  id: string
  team_id: string
  channel_id: string
  title: string
  link: string
  emoji: string
  entity_id: string | null
  app_id: string | null
  rank: string
  created_by: string
  updated_by: string
  date_created: number
  date_updated: number
}

export interface StarRow {
  user_id: string
  /** "message:<channel>/<ts>", "file:<id>" or "channel:<id>". */
  item: string
  team_id: string
  type: "message" | "file" | "channel"
  channel_id: string | null
  ts: string | null
  file_id: string | null
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

/** A custom emoji (migration 0024): an image, or an alias of another name. */
export interface EmojiRow {
  team_id: string
  name: string
  image: string | null
  image_type: string | null
  alias_for: string | null
  created_by: string
  created: number
}
