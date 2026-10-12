import { ApiError, listen, type ApiResult, type Client, type Listener, type RealtimeEvent } from "@campflare/client"
import { createFileCache, type FileCache, type FileCacheOptions } from "./files"
import { type Action, initialState, isReply, keyOf, reduce, type WorkspaceState } from "./state"
import type { Conversation, Message, User } from "./types"

// A live workspace: the store, the Web API calls that fill it, and the RTM link
// that keeps it current. UI code reads state and calls these methods; it never
// calls the Web API itself, so every app and the CLI share one behaviour.

export interface WorkspaceOptions {
  client: Client
  /** For tests and runtimes without a global WebSocket. */
  WebSocket?: typeof globalThis.WebSocket
  /** Live events over RTM (the default), or none (tests, one-shot tools). */
  realtime?: "rtm" | "none"
  /** Reconnect backoff for RTM. */
  minDelayMs?: number
  maxDelayMs?: number
  /** Object URL hooks and grace period for `files` (tests). */
  files?: Omit<FileCacheOptions, "fetchFile">
}

/** A file to upload: its name, bytes, and MIME type if known (for the pending message). */
export interface NewFile {
  name: string
  bytes: Uint8Array<ArrayBuffer>
  type?: string
}

export interface Workspace {
  getState(): WorkspaceState
  /** Called after every change; returns an unsubscribe function. Fits React's useSyncExternalStore. */
  subscribe(listener: () => void): () => void
  /** Loads who you are, people and conversations, then goes live. Idempotent; retries after a failure. */
  start(): Promise<void>
  stop(): void
  /** The newest page of a conversation, or with `older`, the page before what's loaded. */
  loadHistory(channel: string, opts?: { older?: boolean }): Promise<void>
  loadReplies(channel: string, threadTs: string): Promise<void>
  /** Shows the message at once as pending, then as the server stored it, or as failed. */
  send(channel: string, text: string, opts?: { threadTs?: string }): Promise<void>
  /**
   * Uploads files into a conversation (or a thread) with an optional message. Shows a
   * pending message with the files at once; Retry uploads them again after a failure.
   */
  upload(channel: string, files: NewFile[], opts?: { text?: string; threadTs?: string }): Promise<void>
  /** Files' bytes with the session's token, as shared object URLs: see FileCache. */
  readonly files: FileCache
  /** Sends a failed message again. */
  retry(channel: string, localTs: string): Promise<void>
  discard(channel: string, localTs: string): void
  edit(channel: string, ts: string, text: string): Promise<void>
  remove(channel: string, ts: string): Promise<void>
  /** Adds your reaction, or takes it back if it's there. */
  toggleReaction(channel: string, ts: string, name: string): Promise<void>
  /** Marks a conversation read up to its newest loaded message. */
  markRead(channel: string): Promise<void>
  join(channel: string): Promise<void>
  createChannel(name: string, opts?: { isPrivate?: boolean }): Promise<string>
  /** The IM (one user) or group DM (several) with these people, opened if need be. */
  openDm(users: string[]): Promise<string>
}

const HISTORY_PAGE = 50

interface HistoryPage extends ApiResult {
  messages: Message[]
  has_more?: boolean
}

export function createWorkspace(options: WorkspaceOptions): Workspace {
  const { client } = options
  let state = initialState
  const listeners = new Set<() => void>()
  let live: Listener | undefined
  let everConnected = false
  let localSeq = 0
  const fetchingUsers = new Set<string>()
  const fetchingConversations = new Set<string>()
  /** Uploads that failed, by local ts, kept for retry(). */
  const unsent = new Map<string, NewFile[]>()
  const files = createFileCache({ ...options.files, fetchFile: (url) => client.fetchFile(url) })

  function dispatch(action: Action) {
    const next = reduce(state, action)
    if (next === state) return
    state = next
    for (const l of listeners) l()
  }

  const selfId = () => state.self?.userId ?? ""

  const listConversations = () =>
    client.paginate<Conversation>("conversations.list", "channels", {
      types: "public_channel,private_channel,mpim,im",
      exclude_archived: false,
    })

  /** Fills in people and conversations an event mentions that the store hasn't seen. */
  function fillIn(event: RealtimeEvent) {
    const user = event.user
    if (typeof user === "string" && !state.users[user] && !fetchingUsers.has(user)) {
      fetchingUsers.add(user)
      void client
        .call<ApiResult & { user: User }>("users.info", { user })
        .then((r) => dispatch({ type: "users", users: [r.user] }))
        .catch(() => {})
        .finally(() => fetchingUsers.delete(user))
    }
    const channel = event.channel
    if (typeof channel === "string" && !state.conversations[channel] && !fetchingConversations.has(channel)) {
      fetchingConversations.add(channel)
      void client
        .call<ApiResult & { channel: Conversation }>("conversations.info", { channel })
        .then((r) => dispatch({ type: "conversation", conversation: r.channel }))
        .catch(() => {})
        .finally(() => fetchingConversations.delete(channel))
    }
  }

  /** After a reconnect: what changed while the link was down. */
  async function resync() {
    const conversations = await listConversations().catch(() => [])
    for (const conversation of conversations) dispatch({ type: "conversation", conversation })
    await Promise.all(Object.keys(state.timelines).map((c) => loadHistory(c).catch(() => {})))
  }

  function goLive() {
    if (options.realtime === "none") return
    live = listen({
      client,
      mode: "rtm",
      WebSocket: options.WebSocket,
      minDelayMs: options.minDelayMs,
      maxDelayMs: options.maxDelayMs,
      onEvent(event) {
        dispatch({ type: "event", event })
        fillIn(event)
      },
      onStatus(status) {
        dispatch({ type: "connection", status })
        if (status !== "connected") return
        if (everConnected) void resync()
        everConnected = true
      },
    })
  }

  /** Resolves true once loaded; shared by overlapping start() calls. */
  let loading: Promise<boolean> | undefined
  let stopped = false

  // Safe to call again (React's StrictMode does, after a stop()): it loads once and
  // keeps one RTM link. After a failed load, the next call tries again.
  async function start() {
    stopped = false
    loading ??= load()
    if (!(await loading)) {
      loading = undefined
      return
    }
    if (!stopped && !live) goLive()
  }

  async function load(): Promise<boolean> {
    dispatch({ type: "loading" })
    try {
      const [me, users, team] = await Promise.all([
        client.call<ApiResult & { user_id: string; team_id: string; team: string }>("auth.test"),
        client.paginate<User>("users.list", "members"),
        client.call<ApiResult & { team: { name: string } }>("team.info").catch(() => undefined),
      ])
      const conversations = await listConversations()
      dispatch({
        type: "ready",
        self: { url: client.url, userId: me.user_id, teamId: me.team_id, teamName: team?.team.name ?? me.team },
        users,
        conversations,
      })
    } catch (error) {
      dispatch({ type: "failed", error: error instanceof ApiError ? error.code : String(error) })
      return false
    }
    return true
  }

  async function loadHistory(channel: string, opts: { older?: boolean } = {}) {
    const older = Boolean(opts.older)
    const keys = state.timelines[channel]?.keys ?? []
    const oldest = keys.map((k) => state.messages[k]).find((m) => m && !m.pending)?.ts
    if (older && !oldest) return loadHistory(channel)
    const page = await client.call<HistoryPage>("conversations.history", {
      channel,
      limit: HISTORY_PAGE,
      ...(older ? { latest: oldest } : {}),
    })
    dispatch({ type: "history", channel, messages: page.messages, hasMore: Boolean(page.has_more), older })
  }

  async function loadReplies(channel: string, threadTs: string) {
    const replies = await client.paginate<Message>("conversations.replies", "messages", { channel, ts: threadTs })
    dispatch({ type: "replies", channel, threadTs, messages: replies })
  }

  async function post(channel: string, localTs: string, text: string, threadTs?: string, clientMsgId?: string) {
    try {
      const r = await client.call<ApiResult & { ts: string; message?: Message }>("chat.postMessage", {
        channel,
        text,
        thread_ts: threadTs,
        client_msg_id: clientMsgId,
      })
      const message = r.message ?? { ts: r.ts, channel, user: selfId(), text, thread_ts: threadTs }
      dispatch({ type: "sent", channel, localTs, message: { ...message, channel } })
    } catch (error) {
      dispatch({ type: "sendFailed", channel, localTs, error: error instanceof ApiError ? error.code : String(error) })
    }
  }

  async function send(channel: string, text: string, opts: { threadTs?: string } = {}) {
    // "~" sorts after every digit, so a pending message stays at the bottom until it has a real ts.
    const localTs = `~${String(++localSeq).padStart(8, "0")}`
    // The server echoes it on the stored message, so RTM's copy, which can beat the HTTP answer, replaces this one.
    const clientMsgId = crypto.randomUUID()
    dispatch({
      type: "sending",
      message: {
        ts: localTs,
        channel,
        type: "message",
        user: selfId(),
        text,
        thread_ts: opts.threadTs,
        client_msg_id: clientMsgId,
        pending: true,
      },
    })
    await post(channel, localTs, text, opts.threadTs, clientMsgId)
  }

  async function retry(channel: string, localTs: string) {
    const m = state.messages[keyOf(channel, localTs)]
    if (!m?.failed) return
    dispatch({ type: "sending", message: { ...m, failed: undefined, uploaded: undefined } })
    const pendingFiles = unsent.get(localTs)
    if (pendingFiles) return uploadNow(channel, localTs, pendingFiles, m.text ?? "", m.thread_ts)
    await post(channel, localTs, m.text ?? "", m.thread_ts, m.client_msg_id)
  }

  async function uploadNow(channel: string, localTs: string, list: NewFile[], text: string, threadTs?: string) {
    try {
      await client.upload(
        list.map((f) => ({ name: f.name, bytes: f.bytes })),
        {
          channel,
          text: text || undefined,
          threadTs,
          // The message completion posts shares these ids: RTM's copy of it, which can beat
          // the HTTP answer, replaces the pending one (see pendingTwin in state.ts).
          onUploaded: (done) => dispatch({ type: "uploaded", channel, localTs, fileIds: done.map((f) => f.id) }),
        },
      )
    } catch (error) {
      unsent.set(localTs, list)
      dispatch({ type: "sendFailed", channel, localTs, error: error instanceof ApiError ? error.code : String(error) })
      return
    }
    unsent.delete(localTs)
    // files.completeUploadExternal doesn't answer with the message. Load it (RTM may also bring
    // it) before dropping the pending one, so the files never vanish in between.
    await (threadTs ? loadReplies(channel, threadTs) : loadHistory(channel)).catch(() => {})
    dispatch({ type: "discard", channel, localTs })
  }

  async function upload(channel: string, list: NewFile[], opts: { text?: string; threadTs?: string } = {}) {
    if (list.length === 0) return
    const localTs = `~${String(++localSeq).padStart(8, "0")}`
    const text = opts.text ?? ""
    dispatch({
      type: "sending",
      message: {
        ts: localTs,
        channel,
        type: "message",
        user: selfId(),
        text,
        thread_ts: opts.threadTs,
        files: list.map((f, i) => ({
          id: `${localTs}-${i}`,
          name: f.name,
          title: f.name,
          mimetype: f.type,
          size: f.bytes.byteLength,
        })),
        pending: true,
      },
    })
    await uploadNow(channel, localTs, list, text, opts.threadTs)
  }

  async function edit(channel: string, ts: string, text: string) {
    const r = await client.call<ApiResult & { message: Message }>("chat.update", { channel, ts, text })
    dispatch({ type: "event", event: { type: "message", subtype: "message_changed", channel, message: r.message } })
  }

  async function remove(channel: string, ts: string) {
    await client.call("chat.delete", { channel, ts })
    // A thread head with replies becomes a tombstone; the next history load shows it.
    const m = state.messages[keyOf(channel, ts)]
    if (m && !isReply(m) && (m.reply_count ?? 0) > 0) return loadHistory(channel)
    dispatch({ type: "event", event: { type: "message", subtype: "message_deleted", channel, deleted_ts: ts } })
  }

  async function toggleReaction(channel: string, ts: string, name: string) {
    const m = state.messages[keyOf(channel, ts)]
    const mine = m?.reactions?.some((r) => r.name === name && r.users.includes(selfId()))
    const event = { user: selfId(), reaction: name, item: { type: "message", channel, ts } }
    dispatch({ type: "event", event: { type: mine ? "reaction_removed" : "reaction_added", ...event } })
    try {
      await client.call(mine ? "reactions.remove" : "reactions.add", { channel, timestamp: ts, name })
    } catch (error) {
      // The server already agreed with us: nothing to undo.
      const code = error instanceof ApiError ? error.code : ""
      if (code === "already_reacted" || code === "no_reaction") return
      dispatch({ type: "event", event: { type: mine ? "reaction_added" : "reaction_removed", ...event } })
      throw error
    }
  }

  async function markRead(channel: string) {
    const keys = state.timelines[channel]?.keys ?? []
    const newest = keys
      .map((k) => state.messages[k])
      .filter((m) => m && !m.pending)
      .at(-1)
    if (!newest) return
    const c = state.conversations[channel]
    if (c?.last_read && c.last_read >= newest.ts && !state.unread[channel]) return
    dispatch({ type: "read", channel, ts: newest.ts })
    await client.call("conversations.mark", { channel, ts: newest.ts })
  }

  async function join(channel: string) {
    const r = await client.call<ApiResult & { channel: Conversation }>("conversations.join", { channel })
    dispatch({ type: "conversation", conversation: { ...r.channel, is_member: true } })
  }

  async function createChannel(name: string, opts: { isPrivate?: boolean } = {}) {
    const r = await client.call<ApiResult & { channel: Conversation }>("conversations.create", {
      name,
      is_private: opts.isPrivate,
    })
    dispatch({ type: "conversation", conversation: { ...r.channel, is_member: true } })
    return r.channel.id
  }

  async function openDm(users: string[]) {
    const r = await client.call<ApiResult & { channel: { id: string } }>("conversations.open", {
      users: users.join(","),
    })
    if (!state.conversations[r.channel.id]) {
      const info = await client.call<ApiResult & { channel: Conversation }>("conversations.info", {
        channel: r.channel.id,
      })
      dispatch({ type: "conversation", conversation: info.channel })
    }
    return r.channel.id
  }

  return {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    start,
    stop() {
      stopped = true
      live?.close()
      live = undefined
      dispatch({ type: "connection", status: "offline" })
    },
    loadHistory,
    loadReplies,
    send,
    retry,
    upload,
    files,
    discard(channel, localTs) {
      unsent.delete(localTs)
      dispatch({ type: "discard", channel, localTs })
    },
    edit,
    remove,
    toggleReaction,
    markRead,
    join,
    createChannel,
    openDm,
  }
}
