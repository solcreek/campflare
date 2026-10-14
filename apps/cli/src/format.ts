// Plain-text rendering for terminals and pipes.

const pad = (n: number) => String(n).padStart(2, "0")

export function time(ts: string): string {
  const d = new Date(Number(ts) * 1000)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** "<@U123>" → "@bob", "<#C1|dev>" → "#dev", "<https://x|label>" → "label (https://x)", entities decoded. */
export function plain(text: string, names: Map<string, string> = new Map()): string {
  return text
    .replace(/<@([UW][A-Z0-9]+)(?:\|([^>]+))?>/g, (_, id: string, label?: string) => `@${label ?? names.get(id) ?? id}`)
    .replace(/<#([CG][A-Z0-9]+)(?:\|([^>]*))?>/g, (_, id: string, label?: string) => `#${label || id}`)
    .replace(/<!(here|channel|everyone)(?:\|[^>]*)?>/g, "@$1")
    .replace(/<(https?:[^|>]+)\|([^>]+)>/g, "$2 ($1)")
    .replace(/<(https?:[^>]+)>/g, "$1")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
}

export interface MessageLike {
  ts: string
  user?: string
  username?: string
  text?: string
  reply_count?: number
  files?: { name?: string }[]
  bot_profile?: { name?: string }
}

export function messageLine(m: MessageLike, names: Map<string, string>, prefix = ""): string {
  const who = m.user ? (names.get(m.user) ?? m.user) : (m.username ?? m.bot_profile?.name ?? "bot")
  const files = m.files?.length ? ` [${m.files.map((f) => f.name ?? "file").join(", ")}]` : ""
  const replies = m.reply_count ? ` (${m.reply_count} ${m.reply_count === 1 ? "reply" : "replies"})` : ""
  const text = plain(m.text ?? "", names)
  return `${prefix}${time(m.ts)}  ${who}:${text ? ` ${text}` : ""}${files}${replies}`
}

/** An app's event delivery health, as campflare.apps.info gives it (event_subscriptions). */
export interface EventDelivery {
  disabled?: { at: number; reason: string } | null
  delivery?: {
    last_attempt: { at: number; ok: boolean; status: number; reason: string | null } | null
    window_minutes: number
    attempts: number
    failures: number
    pending: number
  }
}

/** Lines saying how an app's Request URL is doing; none before its first delivery. */
export function deliveryLines(subs: EventDelivery): string[] {
  const lines: string[] = []
  if (subs.disabled) {
    lines.push(
      `Event delivery: OFF since ${time(String(subs.disabled.at))}: ${subs.disabled.reason}`,
      "  Set the Request URL again (--request-url) to turn it back on.",
    )
  }
  const d = subs.delivery
  if (d?.last_attempt) {
    const last = d.last_attempt
    const how = last.ok
      ? `ok (HTTP ${last.status})`
      : last.status
        ? `HTTP ${last.status}`
        : `no answer (${last.reason})`
    lines.push(
      `Last delivery: ${time(String(last.at))}, ${how}`,
      `Last ${d.window_minutes} min: ${d.attempts} attempts, ${d.failures} failed, ${d.pending} waiting to retry`,
    )
  }
  return lines
}
