// Slack's mrkdwn, parsed into a tree a UI renders without HTML strings:
// https://docs.slack.dev/messaging/formatting-message-text
//
// Text arrives with &, < and > escaped; <…> are links, mentions and the like.
// Bold, italic and strike need a boundary on each side that isn't a letter or
// digit, as in Slack, so snake_case_names stay as they are.

export type Inline =
  | { type: "text"; text: string }
  | { type: "bold" | "italic" | "strike"; children: Inline[] }
  | { type: "code"; text: string }
  | { type: "link"; url: string; label?: string }
  | { type: "user"; id: string; label?: string }
  | { type: "channel"; id: string; label?: string }
  | { type: "broadcast"; name: string }
  | { type: "emoji"; name: string }

export type Block =
  | { type: "paragraph"; children: Inline[] }
  | { type: "quote"; children: Inline[] }
  | { type: "pre"; text: string }
  // Markdown only (see markdown.ts): mrkdwn has no headings, lists or rules.
  | { type: "heading"; level: number; children: Inline[] }
  | { type: "list"; ordered: boolean; start: number; items: Inline[][] }
  | { type: "rule" }

/** The blocks mrkdwn has. */
export type MrkdwnBlock = Extract<Block, { type: "paragraph" | "quote" | "pre" }>

export function unescape(text: string): string {
  return text.replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&amp;", "&")
}

const B = "(?<![\\p{L}\\p{N}])"
const E = "(?![\\p{L}\\p{N}])"
const INLINE = new RegExp(
  [
    "<([^<>\\n]+)>",
    "`([^`\\n]+)`",
    `${B}\\*([^*\\n]+)\\*${E}`,
    `${B}_([^_\\n]+)_${E}`,
    `${B}~([^~\\n]+)~${E}`,
    ":([a-z0-9_+'-]+):",
  ].join("|"),
  "gu",
)

/** What a <…> holds: a link, a mention or a broadcast. */
export function angle(inner: string): Inline {
  const bar = inner.indexOf("|")
  const target = bar < 0 ? inner : inner.slice(0, bar)
  const label = bar < 0 ? undefined : unescape(inner.slice(bar + 1))
  if (target.startsWith("@")) return { type: "user", id: target.slice(1), label }
  if (target.startsWith("#")) return { type: "channel", id: target.slice(1), label }
  if (target.startsWith("!")) {
    const name = target.slice(1).split("^")[0]!
    return label ? { type: "text", text: label } : { type: "broadcast", name }
  }
  return { type: "link", url: unescape(target), label }
}

export function parseInline(text: string): Inline[] {
  const out: Inline[] = []
  let last = 0
  const push = (node: Inline) => {
    const prev = out.at(-1)
    if (node.type === "text" && prev?.type === "text") prev.text += node.text
    else out.push(node)
  }
  for (const m of text.matchAll(INLINE)) {
    if (m.index > last) push({ type: "text", text: unescape(text.slice(last, m.index)) })
    const [, link, code, bold, italic, strike, emoji] = m
    if (link !== undefined) push(angle(link))
    else if (code !== undefined) push({ type: "code", text: unescape(code) })
    else if (bold !== undefined) push({ type: "bold", children: parseInline(bold) })
    else if (italic !== undefined) push({ type: "italic", children: parseInline(italic) })
    else if (strike !== undefined) push({ type: "strike", children: parseInline(strike) })
    else push({ type: "emoji", name: emoji! })
    last = m.index + m[0].length
  }
  if (last < text.length) push({ type: "text", text: unescape(text.slice(last)) })
  return out
}

/** Paragraphs, "> " quotes and ``` blocks. Newlines inside a paragraph stay in its text. */
export function parse(text: string): MrkdwnBlock[] {
  const blocks: MrkdwnBlock[] = []
  const parts = text.split("```")
  // A fence that never closes is text.
  if (parts.length % 2 === 0) parts.splice(-2, 2, `${parts.at(-2)}\`\`\`${parts.at(-1)}`)
  parts.forEach((part, i) => {
    // The newlines around a fence belong to the fence.
    let source = part
    if (i > 0) source = source.replace(/^\n/, "")
    if (i < parts.length - 1) source = source.replace(/\n$/, "")
    if (i % 2 === 1) {
      blocks.push({ type: "pre", text: unescape(source) })
      return
    }
    let lines: string[] = []
    let quoting = false
    const flush = () => {
      const joined = lines.join("\n")
      if (joined.trim()) blocks.push({ type: quoting ? "quote" : "paragraph", children: parseInline(joined) })
      lines = []
    }
    for (const line of source.split("\n")) {
      const quoted = /^(&gt;|>) ?/.exec(line)
      if (Boolean(quoted) !== quoting) {
        flush()
        quoting = Boolean(quoted)
      }
      lines.push(quoted ? line.slice(quoted[0].length) : line)
    }
    flush()
  })
  return blocks
}

/** The text without markup, for previews, notifications and titles. */
export function plainText(
  text: string,
  names: { user?: (id: string) => string; channel?: (id: string) => string } = {},
) {
  const flat = (nodes: Inline[]): string =>
    nodes
      .map((n) => {
        switch (n.type) {
          case "text":
          case "code":
            return n.text
          case "bold":
          case "italic":
          case "strike":
            return flat(n.children)
          case "link":
            return n.label ?? n.url
          case "user":
            return `@${n.label ?? names.user?.(n.id) ?? n.id}`
          case "channel":
            return `#${n.label ?? names.channel?.(n.id) ?? n.id}`
          case "broadcast":
            return `@${n.name}`
          case "emoji":
            return emojiChar(n.name) ?? `:${n.name}:`
        }
      })
      .join("")
  return parse(text)
    .map((b) => (b.type === "pre" ? b.text : flat(b.children)))
    .join("\n")
}

// The shortcodes people type most, and every reaction the seed data uses.
// Anything else renders as its :name: until a full table is worth its weight.
const EMOJI: Record<string, string> = {
  "+1": "👍",
  thumbsup: "👍",
  "-1": "👎",
  thumbsdown: "👎",
  smile: "😄",
  smiley: "😃",
  grinning: "😀",
  joy: "😂",
  laughing: "😆",
  wink: "😉",
  blush: "😊",
  heart_eyes: "😍",
  thinking_face: "🤔",
  sweat_smile: "😅",
  cry: "😢",
  sob: "😭",
  scream: "😱",
  rage: "😡",
  sunglasses: "😎",
  slightly_smiling_face: "🙂",
  upside_down_face: "🙃",
  wave: "👋",
  clap: "👏",
  pray: "🙏",
  muscle: "💪",
  ok_hand: "👌",
  raised_hands: "🙌",
  point_up: "☝️",
  eyes: "👀",
  heart: "❤️",
  broken_heart: "💔",
  fire: "🔥",
  tada: "🎉",
  rocket: "🚀",
  sparkles: "✨",
  star: "⭐",
  zap: "⚡",
  boom: "💥",
  "100": "💯",
  white_check_mark: "✅",
  heavy_check_mark: "✔️",
  x: "❌",
  warning: "⚠️",
  question: "❓",
  exclamation: "❗",
  bulb: "💡",
  memo: "📝",
  calendar: "📆",
  coffee: "☕",
  ramen: "🍜",
  pizza: "🍕",
  beers: "🍻",
  bug: "🐛",
  wrench: "🔧",
  hammer: "🔨",
  lock: "🔒",
  key: "🔑",
  bell: "🔔",
  mag: "🔍",
  link: "🔗",
  pushpin: "📌",
  speech_balloon: "💬",
  see_no_evil: "🙈",
  shrug: "🤷",
  facepalm: "🤦",
  saluting_face: "🫡",
  melting_face: "🫠",
  campfire: "🏕️",
}

export function emojiChar(name: string): string | undefined {
  return EMOJI[name]
}

/** Common shortcodes, for a reaction picker. */
export const commonEmoji = ["+1", "heart", "joy", "eyes", "tada", "raised_hands", "fire", "white_check_mark"]
