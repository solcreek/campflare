// Rewriting an export's text for this workspace (docs/import.md, Mapping).

const USER_MENTION = /<@([UW][A-Z0-9]+)(?:\|([^>]*))?>/g
const CHANNEL_LINK = /<#([CGD][A-Z0-9]+)(?:\|([^>]*))?>/g

/** The source's system user (Slackbot): its id stays as it is, as Campflare's tombstones already use it. */
export const SYSTEM_USER_ID = "USLACKBOT"

/** The user ids a text mentions. */
export function mentionedUsers(text: string): string[] {
  return [...text.matchAll(USER_MENTION)].map((m) => m[1]!)
}

/** The conversation ids a text links to. */
export function linkedConversations(text: string): string[] {
  return [...text.matchAll(CHANNEL_LINK)].map((m) => m[1]!)
}

/**
 * `<@U…>` to the mapped user (an unmapped one with a label becomes `@label`,
 * without stays, and is noted in `unmapped`); `<#C…|name>` to the mapped
 * conversation, without the old name, which a rename may have changed.
 */
export function rewriteText(
  text: string,
  users: Map<string, string>,
  conversations: Map<string, string>,
  unmapped: Set<string>,
): string {
  return text
    .replace(USER_MENTION, (whole, id: string, label: string | undefined) => {
      const to = users.get(id)
      if (to) return `<@${to}>`
      unmapped.add(id)
      return label ? `@${label}` : whole
    })
    .replace(CHANNEL_LINK, (whole, id: string) => {
      const to = conversations.get(id)
      return to ? `<#${to}>` : whole
    })
}

/** The line that stands in a message for a file that wasn't imported (yet). */
export const fileLine = (name: string) => `[file not imported: ${name}]`

/** Text with a file's line taken out, and the line break that joined it. */
export function withoutFileLine(text: string, name: string): string {
  const line = fileLine(name)
  const lines = text.split("\n")
  const at = lines.indexOf(line)
  if (at < 0) return text
  lines.splice(at, 1)
  return lines.join("\n")
}

/** A valid handle from an export's name: lower case, letters, digits, `.`, `_`, `-`. */
export function handleFrom(name: string): string {
  const handle = name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[^a-z0-9]+/, "")
    .slice(0, 64)
  return handle || "user"
}

/** A valid channel name from an export's (Slack's are valid already; this guards the rest). */
export function channelNameFrom(name: string): string {
  const normalized = name
    .replace(/^#/, "")
    .trim()
    .toLowerCase()
    .replace(/[^\p{Ll}\p{Lo}\p{N}_-]+/gu, "-")
    .slice(0, 64)
  return normalized || "imported"
}

/** The names to try, in order: the name, then `-imported`, `-imported-2`… */
export function candidates(name: string, count = 10): string[] {
  return [name, `${name}-imported`, ...Array.from({ length: count - 2 }, (_, i) => `${name}-imported-${i + 2}`)]
}
