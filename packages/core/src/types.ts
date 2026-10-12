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
  files?: { id: string; name?: string; mimetype?: string; url_private?: string; [key: string]: unknown }[]
  is_ephemeral?: boolean
  /** Local only: sent, not yet confirmed by the server. Its ts is a placeholder. */
  pending?: boolean
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
