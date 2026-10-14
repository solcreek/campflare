import { angle, type Block, type Inline } from "./mrkdwn"

// Markdown, as apps send it in `markdown_text` and `markdown` blocks (the
// common CommonMark subset LLMs write), parsed into the same tree as mrkdwn so
// one renderer draws both, never as HTML. It is read while it streams in, so
// anything unfinished (an unclosed fence, a lone `**`) reads as what it is so far.
//
// Blocks: paragraphs, # headings, > quotes, - and 1. lists, ``` fences, rules.
// Inline: **bold**, *italic*, ~~strike~~, `code`, [label](url), <url> and bare
// URLs, and Slack's <@U…> mentions and :emoji:. Single * and _ need a boundary
// that isn't a letter or digit, so snake_case_names and 2*3*4 stay as they are.

const B = "(?<![\\p{L}\\p{N}*_])"
const E = "(?![\\p{L}\\p{N}*_])"
const INLINE = new RegExp(
  [
    "`([^`\\n]+)`",
    "\\[([^\\]\\n]+)\\]\\(([^()\\s]+)\\)",
    "<([^<>\\n]+)>",
    "\\*\\*([^\\n]+?)\\*\\*",
    "__([^\\n]+?)__",
    "~~([^~\\n]+)~~",
    `${B}\\*([^*\\n]+)\\*${E}`,
    `${B}_([^_\\n]+)_${E}`,
    ":([a-z0-9_+'-]+):",
    "(https?://[^\\s<>()]*[^\\s<>().,;:!?'\"])",
  ].join("|"),
  "gu",
)

export function parseMarkdownInline(text: string): Inline[] {
  const out: Inline[] = []
  let last = 0
  const push = (node: Inline) => {
    const prev = out.at(-1)
    if (node.type === "text" && prev?.type === "text") prev.text += node.text
    else out.push(node)
  }
  for (const m of text.matchAll(INLINE)) {
    if (m.index > last) push({ type: "text", text: text.slice(last, m.index) })
    const [, code, label, url, angled, bold, bold2, strike, italic, italic2, emoji, bare] = m
    if (code !== undefined) push({ type: "code", text: code })
    else if (label !== undefined) push({ type: "link", url: url!, label })
    else if (angled !== undefined) push(angle(angled))
    else if (bold !== undefined || bold2 !== undefined)
      push({ type: "bold", children: parseMarkdownInline((bold ?? bold2)!) })
    else if (strike !== undefined) push({ type: "strike", children: parseMarkdownInline(strike) })
    else if (italic !== undefined || italic2 !== undefined)
      push({ type: "italic", children: parseMarkdownInline((italic ?? italic2)!) })
    else if (emoji !== undefined) push({ type: "emoji", name: emoji })
    else push({ type: "link", url: bare! })
    last = m.index + m[0].length
  }
  if (last < text.length) push({ type: "text", text: text.slice(last) })
  return out
}

const FENCE = /^ {0,3}(```|~~~)/
const HEADING = /^ {0,3}(#{1,6})\s+(.*?)\s*#*\s*$/
const RULE = /^ {0,3}([-*_])(?:\s*\1){2,}\s*$/
const QUOTE = /^ {0,3}> ?/
const BULLET = /^ {0,3}[-*+]\s+(.*)$/
const NUMBERED = /^ {0,3}(\d{1,9})[.)]\s+(.*)$/

/** Whether a line starts a block of its own, ending a paragraph. */
const startsBlock = (line: string) =>
  FENCE.test(line) ||
  HEADING.test(line) ||
  RULE.test(line) ||
  QUOTE.test(line) ||
  BULLET.test(line) ||
  NUMBERED.test(line)

export function parseMarkdown(text: string): Block[] {
  const blocks: Block[] = []
  const lines = text.split("\n")
  let i = 0
  while (i < lines.length) {
    const line = lines[i]!
    if (!line.trim()) {
      i++
      continue
    }
    const fence = FENCE.exec(line)
    if (fence) {
      // Unclosed (still streaming): to the end.
      const body: string[] = []
      for (i++; i < lines.length && !lines[i]!.trimStart().startsWith(fence[1]!); i++) body.push(lines[i]!)
      i++
      blocks.push({ type: "pre", text: body.join("\n") })
      continue
    }
    const heading = HEADING.exec(line)
    if (heading) {
      blocks.push({ type: "heading", level: heading[1]!.length, children: parseMarkdownInline(heading[2]!) })
      i++
      continue
    }
    if (RULE.test(line)) {
      blocks.push({ type: "rule" })
      i++
      continue
    }
    if (QUOTE.test(line)) {
      const quoted: string[] = []
      for (; i < lines.length && QUOTE.test(lines[i]!); i++) quoted.push(lines[i]!.replace(QUOTE, ""))
      blocks.push({ type: "quote", children: parseMarkdownInline(quoted.join("\n")) })
      continue
    }
    const numbered = NUMBERED.exec(line)
    if (numbered || BULLET.test(line)) {
      const pattern = numbered ? NUMBERED : BULLET
      const items: string[] = []
      while (i < lines.length) {
        const item = pattern.exec(lines[i]!)
        if (item) items.push(item.at(-1)!)
        // An indented line goes on with the item before it.
        else if (/^\s+\S/.test(lines[i]!) && !startsBlock(lines[i]!)) items[items.length - 1] += `\n${lines[i]!.trim()}`
        else break
        i++
      }
      blocks.push({
        type: "list",
        ordered: Boolean(numbered),
        start: numbered ? Number(numbered[1]) : 1,
        items: items.map(parseMarkdownInline),
      })
      continue
    }
    const paragraph: string[] = []
    for (; i < lines.length && lines[i]!.trim() && (paragraph.length === 0 || !startsBlock(lines[i]!)); i++)
      paragraph.push(lines[i]!)
    blocks.push({ type: "paragraph", children: parseMarkdownInline(paragraph.join("\n")) })
  }
  return blocks
}
