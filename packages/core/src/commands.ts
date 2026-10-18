// Slash commands in the composer (docs/commands-webhooks.md): a draft that
// starts with a registered /name runs that command instead of being sent, and
// while the first word is being typed the matching commands are offered.

/** A command an app registered (campflare.commands.list). */
export interface SlashCommand {
  command: string
  description: string
  usage_hint: string
  app_id: string
  app_name?: string
}

/** What a draft runs: a registered command and the text after it; undefined when it's a message to send. */
export function commandIn(draft: string, commands: SlashCommand[]): { command: string; text: string } | undefined {
  const match = /^\/(\S+)(?:\s+([\s\S]*))?$/.exec(draft.trim())
  if (!match) return undefined
  // As the server stores names: NFC, so a decomposed "é" (some keyboards, pasted text) still matches.
  const name = `/${match[1]!.normalize("NFC").toLowerCase()}`
  if (!commands.some((c) => c.command === name)) return undefined
  return { command: name, text: (match[2] ?? "").trim() }
}

/**
 * The commands to offer while the draft is a slash and the start of a name
 * (no space yet): those whose name starts with it, in name order.
 */
export function commandSuggestions(draft: string, commands: SlashCommand[]): SlashCommand[] {
  if (!/^\/\S*$/.test(draft)) return []
  const typed = draft.normalize("NFC").toLowerCase()
  return commands.filter((c) => c.command.startsWith(typed)).toSorted((a, b) => a.command.localeCompare(b.command))
}
