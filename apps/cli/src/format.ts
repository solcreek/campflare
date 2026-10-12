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
