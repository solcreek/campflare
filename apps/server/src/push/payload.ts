import type { PushMessage } from "./send"

// What a notification says (docs/push.md): who and where in the title, the
// message as plain text in the body, the app's route to it for a click.

/** The longest body, in characters: a lock screen shows a few lines anyway. */
export const BODY_LIMIT = 300
/** The longest title: a bot's name can be long. */
export const TITLE_LIMIT = 100

/** An activity item as activity_added carries it (activityJson()). */
export interface PushItem {
  id: string
  type: string
  channel: string
  ts: string
  thread_ts?: string
  actor?: string
  reaction?: string
  message?: { text?: string; user?: string; files?: unknown[]; username?: string }
}

export interface Names {
  users: Map<string, string>
  conversations: Map<string, { name: string; kind: string }>
}

export interface NotificationPayload {
  title: string
  body: string
  /** The conversation: a device shows one notification per conversation, the newest. */
  tag: string
  /** The app's hash route to the message. */
  route: string
  item: string
  type: string
  channel: string
  ts: string
}

const ENTITIES: Record<string, string> = { "&lt;": "<", "&gt;": ">", "&amp;": "&" }

/**
 * A `<!…>` as text: the broadcasts and a user group as @mentions, a date as
 * its fallback text, anything else as its label (or nothing).
 */
function special(command: string, label: string | undefined): string {
  if (/^(here|channel|everyone)$/.test(command)) return `@${(label || command).replace(/^@/, "")}`
  if (command.startsWith("subteam^")) return label ? `@${label.replace(/^@/, "")}` : "@group"
  return label ?? ""
}

/** Slack mrkdwn as a notification shows it: mentions as @name, links as their label, entities decoded. */
export function plainText(text: string, names: Names): string {
  return text
    .replace(/<([^>\s]+?)(?:\|([^>]*))?>/g, (_, target: string, label?: string) => {
      if (target.startsWith("@")) return `@${label || names.users.get(target.slice(1)) || "someone"}`
      if (target.startsWith("#")) {
        return `#${label || names.conversations.get(target.slice(1))?.name || "channel"}`
      }
      if (target.startsWith("!")) return special(target.slice(1), label)
      return label || target.replace(/^mailto:/, "")
    })
    .replace(/&(lt|gt|amp);/g, (e) => ENTITIES[e]!)
    .replace(/\s+/g, " ")
    .trim()
}

/** The user ids a text names, to read their names with the rest. */
export const namedUsers = (text: string) => [...text.matchAll(/<@([UW][A-Z0-9]+)/g)].map((m) => m[1]!)

function truncate(text: string, limit: number): string {
  const chars = [...text]
  return chars.length <= limit ? text : `${chars.slice(0, limit - 1).join("")}…`
}

/** The app's route to the item's message: in its thread when it's a reply. */
export function routeOf(item: Pick<PushItem, "channel" | "ts" | "thread_ts">): string {
  const path = item.thread_ts ? `#/${item.channel}/${item.thread_ts}` : `#/${item.channel}`
  return `${path}?msg=${item.ts}`
}

/** The push for one item: payload, urgency, topic. */
export function itemPush(item: PushItem, names: Names): PushMessage & { payload: NotificationPayload } {
  const who =
    (item.actor && names.users.get(item.actor)) || item.message?.username || (item.actor ? "Someone" : "Campflare")
  const c = names.conversations.get(item.channel)
  const where = !c ? "" : c.kind === "im" ? "" : c.kind === "mpim" ? " in a group DM" : ` in #${c.name}`
  const title = truncate(
    item.type === "reaction"
      ? `${who} reacted :${item.reaction ?? ""}:${where}`
      : item.type === "thread_reply"
        ? `${who} replied${where}`
        : `${who}${where}`,
    TITLE_LIMIT,
  )
  const text = plainText(item.message?.text ?? "", names)
  const body = truncate(text || (item.message?.files?.length ? "sent a file" : "sent a message"), BODY_LIMIT)
  return {
    payload: {
      title,
      body,
      tag: item.channel,
      route: routeOf(item),
      item: item.id,
      type: item.type,
      channel: item.channel,
      ts: item.ts,
    },
    urgency: item.type === "mention" || item.type === "dm" ? "high" : "normal",
    topic: item.channel,
  }
}
