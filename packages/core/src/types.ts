// The parts of Slack's JSON shapes that apps read. The server sends more; the
// index signatures keep the rest reachable without typing all of it.

export interface User {
  id: string
  name: string
  real_name?: string
  deleted?: boolean
  is_bot?: boolean
  color?: string
  profile?: {
    display_name?: string
    real_name?: string
    image_48?: string
    image_72?: string
    status_text?: string
    status_emoji?: string
    [key: string]: unknown
  }
  [key: string]: unknown
}

export interface Conversation {
  id: string
  name?: string
  is_channel?: boolean
  is_group?: boolean
  is_im?: boolean
  is_mpim?: boolean
  is_private?: boolean
  is_archived?: boolean
  is_general?: boolean
  is_member?: boolean
  /** The other person, for an IM. */
  user?: string
  last_read?: string
  topic?: { value: string }
  purpose?: { value: string }
  [key: string]: unknown
}

export interface Reaction {
  name: string
  users: string[]
  count: number
}

/** A file in a message (Slack's file object), or `mode: "tombstone"` where one was deleted. */
export interface MessageFile {
  id: string
  name?: string
  title?: string
  mimetype?: string
  filetype?: string
  pretty_type?: string
  size?: number
  mode?: string
  url_private?: string
  url_private_download?: string
  original_w?: number
  original_h?: number
  alt_txt?: string
  [key: string]: unknown
}

/** A Block Kit block, as far as apps read it. */
export interface MessageBlock {
  type: string
  text?: unknown
  [key: string]: unknown
}

export interface Message {
  ts: string
  /** Not in Slack's message JSON (the channel is implied); the store always sets it. */
  channel: string
  type?: string
  subtype?: string
  user?: string
  bot_id?: string
  text?: string
  thread_ts?: string
  reply_count?: number
  reply_users?: string[]
  latest_reply?: string
  reactions?: Reaction[]
  edited?: { user: string; ts: string }
  files?: MessageFile[]
  /** Block Kit blocks; a `markdown` block's text is markdown, not mrkdwn. */
  blocks?: MessageBlock[]
  /** A streamed message (chat.startStream): "in_progress" while its app writes it, then "completed". */
  streaming_state?: string
  is_ephemeral?: boolean
  /** The conversation it's pinned to (its own), when it is. */
  pinned_to?: string[]
  /** You saved it for later (stars). */
  is_starred?: boolean
  /** Set by the sender, echoed by the server: ties a stored message to the pending one it replaces. */
  client_msg_id?: string
  /** Local only: sent, not yet confirmed by the server. Its ts is a placeholder. */
  pending?: boolean
  /** Local only: a pending upload's file ids on the server, once its bytes are stored. */
  uploaded?: string[]
  /** Local only: sending failed with this error code. */
  failed?: string
  [key: string]: unknown
}

export interface Self {
  url: string
  userId: string
  teamId: string
  teamName: string
}

/** A pinned message, as pins.list and pin_added carry it. */
export interface Pin {
  ts: string
  /** When it was pinned, in seconds. */
  created: number
  createdBy: string
  message: Message
}

/** A link in a conversation's bookmarks bar (bookmarks.list). */
export interface Bookmark {
  id: string
  channel_id: string
  title: string
  link: string
  emoji?: string
  /** Bar order: bookmarks sort by it as text. */
  rank: string
  [key: string]: unknown
}
