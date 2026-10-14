// What an app receives beyond the events everyone sees: derived events like
// app_mention, as Slack's Events API sends them.

type Event = Record<string, unknown> & { type: string }

/** Message subtypes that are someone saying something new: what an app_mention is sent for. */
const SAYING = new Set<unknown>([undefined, "thread_broadcast", "file_share", "bot_message"])

/** `<@U123>` or `<@U123|name>`. */
const MENTION = /<@([UW][A-Z0-9]+)(?:\|[^>]*)?>/g

/**
 * The users a new message mentions. None for anything but a new message:
 * edits (message_changed), deletions and hidden events never mention anyone.
 */
export function mentionedUsers(event: Record<string, unknown>): Set<string> {
  if (event.type !== "message" || event.hidden || !SAYING.has(event.subtype) || typeof event.text !== "string") {
    return new Set()
  }
  return new Set([...event.text.matchAll(MENTION)].map((m) => m[1]!))
}

/** The message fields an app_mention carries, as Slack's does (no channel_type, no subtype). */
const MENTION_FIELDS = [
  "client_msg_id",
  "user",
  "bot_id",
  "app_id",
  "text",
  "ts",
  "team",
  "blocks",
  "files",
  "upload",
  "thread_ts",
  "parent_user_id",
  "channel",
  "event_ts",
] as const

/** Slack's app_mention for a message that mentions an app's bot user. */
export function appMentionOf(message: Record<string, unknown>): Event {
  const event: Event = { type: "app_mention" }
  for (const key of MENTION_FIELDS) if (message[key] !== undefined) event[key] = message[key]
  return event
}

/** Slack's message subscriptions, by the conversation's channel_type. */
const MESSAGE_SUBSCRIPTION: Record<string, string> = {
  channel: "message.channels",
  group: "message.groups",
  im: "message.im",
  mpim: "message.mpim",
}

/** An event type subscription: "app_mention", "reaction_added", "message", "message.channels"… */
export const EVENT_TYPE = /^[a-z][a-z_]*(\.[a-z_]+)?$/

/**
 * Whether an app subscribed to an event: every event without a list, else by
 * its type, and a message also by Slack's per-conversation-kind names.
 */
export function subscribed(types: string[] | undefined, event: Record<string, unknown>): boolean {
  if (!types) return true
  const type = event.type as string
  if (types.includes(type)) return true
  return type === "message" && types.includes(MESSAGE_SUBSCRIPTION[event.channel_type as string] ?? "")
}
