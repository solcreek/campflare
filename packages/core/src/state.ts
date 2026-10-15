import type { RealtimeEvent } from "@campflare/client"
import type { Bookmark, Conversation, Message, Pin, Reaction, Self, User } from "./types"
import type { View } from "./views"

// The workspace as an app sees it, and one pure function that moves it on.
// Every change, whether a Web API answer or an RTM event, is an Action, so the
// same sequence of actions always gives the same state, and tests need no server.

export interface Timeline {
  /** Message keys (see keyOf), oldest first. */
  keys: string[]
  /** Older messages exist on the server. */
  hasMore: boolean
}

export interface WorkspaceState {
  status: "idle" | "loading" | "ready" | "error"
  error?: string
  connection: "offline" | "connecting" | "connected" | "disconnected"
  self?: Self
  users: Record<string, User>
  conversations: Record<string, Conversation>
  /** By keyOf(channel, ts). */
  messages: Record<string, Message>
  /** A conversation's top-level messages, by channel id. */
  timelines: Record<string, Timeline>
  /** A thread's replies (the parent excluded), by keyOf(channel, thread_ts). */
  threads: Record<string, Timeline>
  /** Messages from others that arrived live after last_read, by channel id. */
  unread: Record<string, number>
  /** An app's transient status in a thread ("is thinking…"), by keyOf(channel, thread_ts). */
  statuses: Record<string, ThreadStatus>
  /** Modals apps opened for you, bottom of the stack first: the last is shown. */
  views: View[]
  /** A conversation's pinned messages, most recently pinned first, by channel id, once loaded (pins.list). */
  pins: Record<string, Pin[]>
  /** A conversation's bookmarks bar, in rank order, by channel id, once loaded (bookmarks.list). */
  bookmarks: Record<string, Bookmark[]>
  /** The workspace's custom emoji, as emoji.list answers: name → image URL, or "alias:<name>". */
  emoji: Record<string, string>
}

/**
 * What assistant.threads.setStatus sent: shown until the app's next message in
 * the thread, an empty status, or `expires` (seconds since the epoch) passes.
 */
export interface ThreadStatus {
  /** The app's bot user. */
  user: string
  status: string
  loadingMessages?: string[]
  expires: number
}

export type Action =
  | { type: "loading" }
  | { type: "failed"; error: string }
  | { type: "ready"; self: Self; users: User[]; conversations: Conversation[] }
  | { type: "connection"; status: WorkspaceState["connection"] }
  | { type: "users"; users: User[] }
  | { type: "conversation"; conversation: Conversation }
  /** A page of conversations.history, newest first as the API returns it. */
  | { type: "history"; channel: string; messages: Message[]; hasMore: boolean; older: boolean }
  /** conversations.replies: the parent first, then its replies. */
  | { type: "replies"; channel: string; threadTs: string; messages: Message[] }
  | { type: "sending"; message: Message }
  | { type: "sent"; channel: string; localTs: string; message: Message }
  /** A pending upload's files are stored on the server under these ids, not yet shared. */
  | { type: "uploaded"; channel: string; localTs: string; fileIds: string[] }
  | { type: "sendFailed"; channel: string; localTs: string; error: string }
  /** Drops a message that never reached the server. */
  | { type: "discard"; channel: string; localTs: string }
  | { type: "read"; channel: string; ts: string }
  | { type: "event"; event: RealtimeEvent }
  /** Your open views, as the server has them now (campflare.views.list, or an answer to a submit or close). */
  | { type: "views"; views: View[] }
  /** pins.list's items for a conversation. */
  | { type: "pins"; channel: string; items: PinItem[] }
  /** bookmarks.list for a conversation. */
  | { type: "bookmarks"; channel: string; bookmarks: Bookmark[] }
  /** emoji.list: every custom emoji, replacing what was held. */
  | { type: "emoji"; emoji: Record<string, string> }

/** A pinned message as the API sends it (pins.list's items, pin_added's item). */
export interface PinItem {
  channel: string
  created: number
  created_by: string
  /** As the API sends it, without `channel`: pinOf() sets it. */
  message: Message
}

export const initialState: WorkspaceState = {
  status: "idle",
  connection: "offline",
  users: {},
  conversations: {},
  messages: {},
  timelines: {},
  threads: {},
  unread: {},
  statuses: {},
  views: [],
  pins: {},
  bookmarks: {},
  emoji: {},
}

export const keyOf = (channel: string, ts: string) => `${channel}/${ts}`

const emptyTimeline: Timeline = { keys: [], hasMore: true }

const tsOf = (key: string) => key.slice(key.indexOf("/") + 1)

/** Keys in ts order. Pending messages (ts "~…") sort after every real one. */
function sorted(keys: Iterable<string>): string[] {
  return [...new Set(keys)].toSorted((a, b) => (tsOf(a) < tsOf(b) ? -1 : tsOf(a) > tsOf(b) ? 1 : 0))
}

const byId = <T extends { id: string }>(items: T[]) => Object.fromEntries(items.map((i) => [i.id, i]))

/** A reply, not a thread head or a broadcast that also shows in the channel. */
export function isReply(m: Pick<Message, "ts" | "thread_ts" | "subtype">): boolean {
  return Boolean(m.thread_ts && m.thread_ts !== m.ts && m.subtype !== "thread_broadcast")
}

export function reduce(state: WorkspaceState, action: Action): WorkspaceState {
  switch (action.type) {
    case "loading":
      return { ...state, status: "loading", error: undefined }
    case "failed":
      return { ...state, status: "error", error: action.error }
    case "ready":
      return {
        ...state,
        status: "ready",
        error: undefined,
        self: action.self,
        users: { ...state.users, ...byId(action.users) },
        conversations: { ...state.conversations, ...byId(action.conversations) },
      }
    case "connection":
      // A new link starts with the statuses still showing (the hub sends them after hello), so
      // ones held from before may have ended while the link was down.
      return {
        ...state,
        connection: action.status,
        ...(action.status === "connected" && Object.keys(state.statuses).length > 0 ? { statuses: {} } : {}),
      }
    case "users":
      return { ...state, users: { ...state.users, ...byId(action.users) } }
    case "conversation":
      return {
        ...state,
        conversations: {
          ...state.conversations,
          [action.conversation.id]: { ...state.conversations[action.conversation.id], ...action.conversation },
        },
      }
    case "history":
      return history(state, action)
    case "replies":
      return replies(state, action)
    case "sending":
      return upsert(state, action.message)
    case "sent":
      return upsert(remove(state, action.channel, action.localTs), { ...action.message, channel: action.channel })
    case "uploaded":
      return patchMessage(state, action.channel, action.localTs, { uploaded: action.fileIds })
    case "sendFailed":
      return patchMessage(state, action.channel, action.localTs, { failed: action.error })
    case "discard":
      return remove(state, action.channel, action.localTs)
    case "read":
      return markRead(state, action.channel, action.ts)
    case "views":
      return { ...state, views: action.views }
    case "pins":
      return { ...state, pins: { ...state.pins, [action.channel]: action.items.map(pinOf) } }
    case "bookmarks":
      return { ...state, bookmarks: { ...state.bookmarks, [action.channel]: byRank(action.bookmarks) } }
    case "emoji":
      return { ...state, emoji: action.emoji }
    case "event":
      return applyEvent(state, action.event)
  }
}

function history(state: WorkspaceState, a: Extract<Action, { type: "history" }>): WorkspaceState {
  const messages = { ...state.messages }
  const page: string[] = []
  for (const m of a.messages) {
    const key = keyOf(a.channel, m.ts)
    messages[key] = { ...m, channel: a.channel }
    page.push(key)
  }
  const before = state.timelines[a.channel]?.keys ?? []
  // A pending message the page holds the stored copy of is that copy now.
  let kept = before.filter((k) => !page.some((p) => standsFor(messages[p]!, messages[k])))
  if (!a.older && page.length > 0) {
    // The latest page is the truth for its range: what it lacks there was deleted meanwhile.
    const oldest = a.messages[a.messages.length - 1]!.ts
    const inPage = new Set(page)
    kept = kept.filter((k) => tsOf(k) < oldest || inPage.has(k) || messages[k]?.pending)
  }
  for (const k of before) if (!kept.includes(k)) delete messages[k]
  const hasMore = a.older || before.length === 0 ? a.hasMore : (state.timelines[a.channel]?.hasMore ?? a.hasMore)
  return {
    ...state,
    messages,
    timelines: { ...state.timelines, [a.channel]: { keys: sorted([...kept, ...page]), hasMore } },
  }
}

function replies(state: WorkspaceState, a: Extract<Action, { type: "replies" }>): WorkspaceState {
  const messages = { ...state.messages }
  const keys: string[] = []
  for (const m of a.messages) {
    messages[keyOf(a.channel, m.ts)] = { ...m, channel: a.channel }
    if (m.ts !== a.threadTs) keys.push(keyOf(a.channel, m.ts))
  }
  const threadKey = keyOf(a.channel, a.threadTs)
  const before = state.threads[threadKey]?.keys ?? []
  // A pending reply the page holds the stored copy of is that copy now.
  for (const k of before) if (keys.some((p) => standsFor(messages[p]!, messages[k]))) delete messages[k]
  const pending = before.filter((k) => messages[k]?.pending)
  return {
    ...state,
    messages,
    threads: { ...state.threads, [threadKey]: { keys: sorted([...keys, ...pending]), hasMore: false } },
  }
}

function patchMessage(state: WorkspaceState, channel: string, ts: string, patch: Partial<Message>): WorkspaceState {
  const key = keyOf(channel, ts)
  const message = state.messages[key]
  if (!message) return state
  return { ...state, messages: { ...state.messages, [key]: { ...message, ...patch } } }
}

/**
 * Whether a stored message is the one a pending message became: a sent message by the
 * client_msg_id the server echoes, an upload by the file ids files.completeUploadExternal shares.
 */
function standsFor(stored: Message, pending: Message | undefined): boolean {
  if (!pending?.pending || stored.pending) return false
  if (stored.client_msg_id && stored.client_msg_id === pending.client_msg_id) return true
  const ids = pending.uploaded ?? []
  return ids.length > 0 && Boolean(stored.files?.some((f) => ids.includes(f.id)))
}

/** The pending message a stored one stands for, in the same conversation or thread. */
function pendingTwin(state: WorkspaceState, m: Message): string | undefined {
  if (m.pending || (!m.client_msg_id && !m.files?.length)) return undefined
  const list = isReply(m) ? state.threads[keyOf(m.channel, m.thread_ts!)] : state.timelines[m.channel]
  return list?.keys.find((k) => standsFor(m, state.messages[k]))
}

/**
 * A newer copy of a known message over the old one. Local fields (pending,
 * failed…) stay unless the copy sets them. pinned_to is the server's to say:
 * every copy it sends carries it when pinned, so a copy without it means
 * unpinned. is_starred is not: it's the caller's alone, and events (sent to
 * everyone) never carry it, so it changes by star events and page loads only.
 */
function merge(known: Message, m: Message): Message {
  const next = { ...known, ...m }
  if (!m.pending && !("pinned_to" in m)) delete next.pinned_to
  return next
}

/** Adds or replaces a message, filing it under its conversation or its thread. */
function upsert(state: WorkspaceState, m: Message): WorkspaceState {
  // RTM's copy of your message can beat chat.postMessage's or an upload's answer: it takes the pending one's place.
  const twin = pendingTwin(state, m)
  if (twin) state = remove(state, m.channel, state.messages[twin]!.ts)
  const key = keyOf(m.channel, m.ts)
  const known = state.messages[key]
  const messages = { ...state.messages, [key]: known ? merge(known, m) : m }
  if (isReply(m)) {
    const threadKey = keyOf(m.channel, m.thread_ts!)
    const thread = state.threads[threadKey] ?? { keys: [], hasMore: false }
    const parent = messages[threadKey]
    if (parent && !known && !m.pending) {
      const users = parent.reply_users ?? []
      messages[threadKey] = {
        ...parent,
        reply_count: (parent.reply_count ?? 0) + 1,
        latest_reply: m.ts,
        reply_users: m.user && !users.includes(m.user) ? [...users, m.user] : users,
      }
    }
    return {
      ...state,
      messages,
      threads: { ...state.threads, [threadKey]: { ...thread, keys: sorted([...thread.keys, key]) } },
    }
  }
  const timeline = state.timelines[m.channel] ?? emptyTimeline
  return {
    ...state,
    messages,
    timelines: { ...state.timelines, [m.channel]: { ...timeline, keys: sorted([...timeline.keys, key]) } },
  }
}

function remove(state: WorkspaceState, channel: string, ts: string): WorkspaceState {
  const key = keyOf(channel, ts)
  const m = state.messages[key]
  if (!m) return state
  const messages = { ...state.messages }
  delete messages[key]
  if (isReply(m)) {
    const threadKey = keyOf(channel, m.thread_ts!)
    const thread = state.threads[threadKey]
    const parent = messages[threadKey]
    if (parent && !m.pending)
      messages[threadKey] = { ...parent, reply_count: Math.max(0, (parent.reply_count ?? 1) - 1) }
    if (!thread) return { ...state, messages }
    return {
      ...state,
      messages,
      threads: { ...state.threads, [threadKey]: { ...thread, keys: thread.keys.filter((k) => k !== key) } },
    }
  }
  const timeline = state.timelines[channel]
  if (!timeline) return { ...state, messages }
  return {
    ...state,
    messages,
    timelines: { ...state.timelines, [channel]: { ...timeline, keys: timeline.keys.filter((k) => k !== key) } },
  }
}

function markRead(state: WorkspaceState, channel: string, ts: string): WorkspaceState {
  const c = state.conversations[channel]
  const unread = { ...state.unread }
  delete unread[channel]
  if (!c) return { ...state, unread }
  return { ...state, unread, conversations: { ...state.conversations, [channel]: { ...c, last_read: ts } } }
}

function react(state: WorkspaceState, event: RealtimeEvent, added: boolean): WorkspaceState {
  const item = event.item as { channel: string; ts: string } | undefined
  const user = event.user as string
  const name = event.reaction as string
  const key = item && keyOf(item.channel, item.ts)
  const m = key && state.messages[key]
  if (!m) return state
  const reactions = [...(m.reactions ?? [])]
  const i = reactions.findIndex((r) => r.name === name)
  const current: Reaction = reactions[i] ?? { name, users: [], count: 0 }
  if (added === current.users.includes(user)) return state
  const users = added ? [...current.users, user] : current.users.filter((u) => u !== user)
  const next = { name, users, count: users.length }
  if (i < 0) reactions.push(next)
  else if (users.length === 0) reactions.splice(i, 1)
  else reactions[i] = next
  return { ...state, messages: { ...state.messages, [key]: { ...m, reactions } } }
}

function patchConversation(state: WorkspaceState, id: string, patch: Partial<Conversation>): WorkspaceState {
  const c = state.conversations[id]
  if (!c) return state
  return { ...state, conversations: { ...state.conversations, [id]: { ...c, ...patch } } }
}

function onMessage(state: WorkspaceState, event: RealtimeEvent): WorkspaceState {
  const channel = event.channel as string
  const subtype = event.subtype as string | undefined
  if (subtype === "message_changed") {
    const m = event.message as Message
    // An edit to a message never loaded would file it out of its place in history.
    if (!state.messages[keyOf(channel, m.ts)]) return state
    // The changed message is whole: blocks or attachments it doesn't have were taken out (an app replacing its buttons).
    return upsert(state, { blocks: undefined, attachments: undefined, ...m, channel })
  }
  if (subtype === "message_deleted") {
    return unpinDeleted(remove(state, channel, event.deleted_ts as string), channel, event.deleted_ts as string)
  }
  const { type: _type, channel_type: _channelType, event_ts: _eventTs, ...fields } = event
  const m = { ...fields, type: "message", channel } as Message
  let next = upsert(state, m)
  // The app's reply ends its status in the thread.
  const threadKey = m.thread_ts && keyOf(channel, m.thread_ts)
  if (threadKey && m.user && next.statuses[threadKey]?.user === m.user) next = setStatus(next, threadKey, undefined)
  const self = state.self?.userId
  if (subtype === "channel_join" && m.user === self) next = patchConversation(next, channel, { is_member: true })
  if (subtype === "channel_leave" && m.user === self) next = patchConversation(next, channel, { is_member: false })
  if (subtype === "channel_topic" && typeof event.topic === "string")
    next = patchConversation(next, channel, { topic: { value: event.topic } })
  if (subtype === "channel_purpose" && typeof event.purpose === "string")
    next = patchConversation(next, channel, { purpose: { value: event.purpose } })
  const lastRead = state.conversations[channel]?.last_read ?? ""
  const fresh = !state.messages[keyOf(channel, m.ts)]
  if (fresh && m.user !== self && !m.is_ephemeral && !isReply(m) && m.ts > lastRead) {
    next = { ...next, unread: { ...next.unread, [channel]: (next.unread[channel] ?? 0) + 1 } }
  }
  return next
}

function setStatus(state: WorkspaceState, key: string, status: ThreadStatus | undefined): WorkspaceState {
  const statuses = { ...state.statuses }
  if (status) statuses[key] = status
  else delete statuses[key]
  return { ...state, statuses }
}

/** assistant_thread_status_changed: an empty status clears it. */
function onStatus(state: WorkspaceState, event: RealtimeEvent): WorkspaceState {
  const key = keyOf(event.channel as string, event.thread_ts as string)
  const status = typeof event.status === "string" ? event.status : ""
  if (!status) return state.statuses[key] ? setStatus(state, key, undefined) : state
  const loading = Array.isArray(event.loading_messages) ? (event.loading_messages as string[]) : []
  const seconds = typeof event.expires_in === "number" ? event.expires_in : 120
  return setStatus(state, key, {
    user: event.user as string,
    status,
    ...(loading.length > 0 ? { loadingMessages: loading } : {}),
    expires: Number(event.event_ts) + seconds,
  })
}

const pinOf = (item: PinItem): Pin => ({
  ts: item.message.ts,
  created: item.created,
  createdBy: item.created_by,
  message: { ...item.message, channel: item.channel },
})

const byRank = (bookmarks: Bookmark[]) => bookmarks.toSorted((a, b) => (a.rank < b.rank ? -1 : a.rank > b.rank ? 1 : 0))

/** Sets or clears a loaded message's field: pinned_to, is_starred. */
function patchLoaded(state: WorkspaceState, channel: string, ts: string, patch: Partial<Message>): WorkspaceState {
  const key = keyOf(channel, ts)
  const m = state.messages[key]
  if (!m) return state
  const next = { ...m, ...patch }
  for (const [k, v] of Object.entries(patch)) if (v === undefined) delete next[k]
  return { ...state, messages: { ...state.messages, [key]: next } }
}

/** pin_added / pin_removed: the message's pinned_to, and the conversation's pins if loaded. */
function onPin(state: WorkspaceState, event: RealtimeEvent, added: boolean): WorkspaceState {
  const item = event.item as PinItem | undefined
  if (!item?.message) return state
  const channel = item.channel
  const ts = item.message.ts
  let next = patchLoaded(state, channel, ts, { pinned_to: added ? [channel] : undefined })
  const pins = state.pins[channel]
  if (pins) {
    const rest = pins.filter((p) => p.ts !== ts)
    next = { ...next, pins: { ...next.pins, [channel]: added ? [pinOf(item), ...rest] : rest } }
  }
  return next
}

/** bookmark_added / _changed / _removed, to a bar that's loaded. */
function onBookmark(state: WorkspaceState, event: RealtimeEvent): WorkspaceState {
  const bookmark = event.bookmark as Bookmark | undefined
  const channel = (event.channel_id as string | undefined) ?? bookmark?.channel_id
  const bar = channel ? state.bookmarks[channel] : undefined
  if (!bookmark || !channel || !bar) return state
  const rest = bar.filter((b) => b.id !== bookmark.id)
  const next = event.type === "bookmark_removed" ? rest : byRank([...rest, bookmark])
  return { ...state, bookmarks: { ...state.bookmarks, [channel]: next } }
}

/** star_added / star_removed: a saved message is_starred. */
function onStar(state: WorkspaceState, event: RealtimeEvent, added: boolean): WorkspaceState {
  const item = event.item as { type?: string; channel?: string; message?: { ts: string } } | undefined
  if (item?.type !== "message" || !item.channel || !item.message) return state
  return patchLoaded(state, item.channel, item.message.ts, { is_starred: added ? true : undefined })
}

/** A deleted message leaves the pins it was in. */
function unpinDeleted(state: WorkspaceState, channel: string, ts: string): WorkspaceState {
  const pins = state.pins[channel]
  if (!pins?.some((p) => p.ts === ts)) return state
  return { ...state, pins: { ...state.pins, [channel]: pins.filter((p) => p.ts !== ts) } }
}

/** emoji_changed: an emoji (or alias) added, emoji removed with their aliases, or one renamed. */
function onEmoji(state: WorkspaceState, event: RealtimeEvent): WorkspaceState {
  const emoji = { ...state.emoji }
  if (event.subtype === "add" && typeof event.name === "string" && typeof event.value === "string") {
    emoji[event.name] = event.value
  } else if (event.subtype === "remove" && Array.isArray(event.names)) {
    for (const name of event.names as string[]) delete emoji[name]
  } else if (event.subtype === "rename" && typeof event.old_name === "string" && typeof event.new_name === "string") {
    const value = typeof event.value === "string" ? event.value : emoji[event.old_name]
    delete emoji[event.old_name]
    if (value !== undefined) emoji[event.new_name] = value
    // Its aliases follow it, as the server's do.
    for (const [name, v] of Object.entries(emoji)) {
      if (v === `alias:${event.old_name}`) emoji[name] = `alias:${event.new_name}`
    }
  } else {
    return state
  }
  return { ...state, emoji }
}

/** One RTM event. Events the store has no use for leave it as it was. */
export function applyEvent(state: WorkspaceState, event: RealtimeEvent): WorkspaceState {
  switch (event.type) {
    case "message":
      return onMessage(state, event)
    case "views_changed":
      return Array.isArray(event.views) ? { ...state, views: event.views as View[] } : state
    case "assistant_thread_status_changed":
      return onStatus(state, event)
    case "reaction_added":
      return react(state, event, true)
    case "reaction_removed":
      return react(state, event, false)
    case "pin_added":
      return onPin(state, event, true)
    case "pin_removed":
      return onPin(state, event, false)
    case "bookmark_added":
    case "bookmark_changed":
    case "bookmark_removed":
      return onBookmark(state, event)
    case "star_added":
      return onStar(state, event, true)
    case "star_removed":
      return onStar(state, event, false)
    case "emoji_changed":
      return onEmoji(state, event)
    case "channel_marked":
    case "group_marked":
    case "im_marked":
      return markRead(state, event.channel as string, event.ts as string)
    case "channel_created": {
      const c = event.channel as Conversation & { creator?: string }
      if (state.conversations[c.id]) return state
      return {
        ...state,
        conversations: { ...state.conversations, [c.id]: { ...c, is_member: c.creator === state.self?.userId } },
      }
    }
    case "channel_rename": {
      const c = event.channel as Conversation
      return patchConversation(state, c.id, { name: c.name })
    }
    case "channel_archive":
      return patchConversation(state, event.channel as string, { is_archived: true })
    case "channel_unarchive":
      return patchConversation(state, event.channel as string, { is_archived: false })
    default:
      return state
  }
}
