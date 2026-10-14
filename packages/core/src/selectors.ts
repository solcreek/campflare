import { keyOf, type ThreadStatus, type WorkspaceState } from "./state"
import type { Conversation, Message, User } from "./types"

// Derived views of the state that every UI needs. Each takes only the parts of
// the state it reads, so a UI can memoise on exactly those.

/** What naming and listing conversations reads. */
export type Directory = Pick<WorkspaceState, "users" | "conversations" | "self">

export function displayName(user: User | undefined): string {
  if (!user) return "unknown"
  return user.profile?.display_name || user.real_name || user.profile?.real_name || user.name
}

/** "general" for a channel, the other person for an IM, everyone else for a group DM. */
export function conversationTitle(state: Pick<WorkspaceState, "users" | "self">, c: Conversation): string {
  if (c.is_im) return displayName(c.user ? state.users[c.user] : undefined)
  if (c.is_mpim) {
    const members = (c.members as string[] | undefined)?.filter((id) => id !== state.self?.userId)
    if (members?.length) return members.map((id) => displayName(state.users[id])).join(", ")
    // mpdm-alex--vincent--ada-1: the handles, without yours
    const self = state.self && state.users[state.self.userId]?.name
    const handles = (c.name ?? "")
      .replace(/^mpdm-/, "")
      .replace(/-\d+$/, "")
      .split("--")
    return handles.filter((h) => h !== self).join(", ")
  }
  return c.name ?? c.id
}

export interface Sidebar {
  channels: Conversation[]
  directMessages: Conversation[]
}

/** Your conversations, channels and DMs apart, each sorted by title; archived ones left out. */
export function sidebar(state: Directory): Sidebar {
  const mine = Object.values(state.conversations).filter((c) => c.is_member !== false && !c.is_archived)
  const byTitle = (a: Conversation, b: Conversation) =>
    conversationTitle(state, a).localeCompare(conversationTitle(state, b))
  return {
    channels: mine.filter((c) => !c.is_im && !c.is_mpim && c.is_member).toSorted(byTitle),
    directMessages: mine.filter((c) => c.is_im || c.is_mpim).toSorted(byTitle),
  }
}

/** Public channels you could join. */
export function browsableChannels(state: Pick<WorkspaceState, "conversations">): Conversation[] {
  return Object.values(state.conversations)
    .filter((c) => c.is_channel && !c.is_private && !c.is_member && !c.is_archived)
    .toSorted((a, b) => (a.name ?? "").localeCompare(b.name ?? ""))
}

export function timeline(state: WorkspaceState, channel: string): Message[] {
  return (state.timelines[channel]?.keys ?? []).flatMap((k) => state.messages[k] ?? [])
}

/** The parent, then its replies. */
export function thread(state: WorkspaceState, channel: string, threadTs: string): Message[] {
  const key = keyOf(channel, threadTs)
  const parent = state.messages[key]
  const replies = (state.threads[key]?.keys ?? []).flatMap((k) => state.messages[k] ?? [])
  return parent ? [parent, ...replies] : replies
}

/** An app's status in a thread, unless it has run out by `now` (seconds since the epoch). */
export function threadStatus(
  statuses: WorkspaceState["statuses"],
  channel: string,
  threadTs: string,
  now: number,
): ThreadStatus | undefined {
  const status = statuses[keyOf(channel, threadTs)]
  return status && status.expires > now ? status : undefined
}
