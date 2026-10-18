import { ApiError, listen, type ApiResult, type Client, type Listener, type RealtimeEvent } from "@campflare/client"
import type { Click } from "./blocks"
import type { SlashCommand } from "./commands"
import { createFileCache, type FileCache, type FileCacheOptions } from "./files"
import {
  type Action,
  applyEvent,
  initialState,
  isReply,
  keyOf,
  type PinItem,
  reduce,
  type WorkspaceState,
} from "./state"
import type { Bookmark, Conversation, Message, User } from "./types"
import type { FormValues, View } from "./views"

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

/** What an app answered a slash command with at once, as it was shown (to you alone, or posted). */
export interface CommandResponse {
  response_type: "ephemeral" | "in_channel"
  text: string
  ts: string
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
  /** A conversation's pinned messages, into `pins`; pin and unpin events keep them current. */
  loadPins(channel: string): Promise<void>
  /** Pins a message to its conversation, or unpins it. */
  setPinned(channel: string, ts: string, pinned: boolean): Promise<void>
  /** A conversation's bookmarks bar, into `bookmarks`; bookmark events keep it current. */
  loadBookmarks(channel: string): Promise<void>
  /** Adds an http(s) link to a conversation's bookmarks bar (the title defaults to the link). */
  addBookmark(channel: string, link: string, opts?: { title?: string; emoji?: string }): Promise<void>
  removeBookmark(channel: string, id: string): Promise<void>
  /** Saves a message for later, or forgets it (stars): the message's is_starred. */
  setSaved(channel: string, ts: string, saved: boolean): Promise<void>
  /**
   * Clicks a button in an app's message (campflare.blocks.action). Resolves
   * once the app has taken it; what the app does about it (a replaced
   * message, an ephemeral reply) arrives as events.
   */
  click(channel: string, ts: string, click: Click): Promise<void>
  /**
   * Stops an app's message that is still streaming (campflare.chat.stopStream),
   * as Slack's stop button does. The completed message arrives as an event.
   */
  stopStream(channel: string, ts: string): Promise<void>
  /** Clicks a button, or chooses in a menu, in an open view; what the form holds so far goes along. */
  clickInView(viewId: string, click: Click, values?: FormValues): Promise<void>
  /**
   * Submits an open view's form. Resolves with the errors to show by
   * block_id (required inputs left empty, or the app's response_action
   * errors), or none once the app took it: the views then open, if any, are
   * in `views`.
   */
  submitView(viewId: string, values: FormValues): Promise<{ errors?: Record<string, string> }>
  /** Closes an open view (and those opened on it). */
  closeView(viewId: string): Promise<void>
  /** The workspace's slash commands, into `commands`; commands_changed reloads them. */
  loadCommands(): Promise<void>
  /**
   * Runs a slash command in a conversation (campflare.commands.invoke), as
   * typing it there does. Resolves with the app's immediate answer, if any;
   * it also arrives as an event (an ephemeral message, or a posted one).
   */
  invokeCommand(channel: string, command: string, text: string): Promise<CommandResponse | undefined>
  /** Marks a conversation read up to its newest loaded message. */
  markRead(channel: string): Promise<void>
  join(channel: string): Promise<void>
  createChannel(name: string, opts?: { isPrivate?: boolean }): Promise<string>
  /** The IM (one user) or group DM (several) with these people, opened if need be. */
  openDm(users: string[]): Promise<string>
  /**
   * Whether the person is looking at this client (its window focused and
   * visible). Told to the server over RTM, now and after every reconnect, so
   * it doesn't push to their devices meanwhile (docs/push.md). Say it again
   * now and then while it holds: the server forgets it after two minutes.
   */
  setActive(active: boolean): void
  /** The server's Web Push key (campflare.push.vapidKey), or null when push isn't configured there. */
  pushKey(): Promise<string | null>
  /** Registers a browser's push subscription (PushSubscription.toJSON()) for this person. */
  subscribePush(subscription: PushSubscriptionInfo, label: string): Promise<void>
  /** Forgets a browser's push subscription, by its endpoint; one the server doesn't know is fine. */
  unsubscribePush(endpoint: string): Promise<void>
  /** Sends a test notification to this person's devices now. */
  testPush(): Promise<{ sent: number; failed: number; removed: number }>
}

/** A browser's push subscription as PushSubscription.toJSON() gives it. */
export interface PushSubscriptionInfo {
  endpoint: string
  keys: { p256dh: string; auth: string }
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
  /** What setActive() last said, to say again on each new link. */
  let active: boolean | undefined
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
    // Events missed while the link was down are lost: what's loaded is read again.
    await Promise.all([
      ...Object.keys(state.timelines).map((c) => loadHistory(c).catch(() => {})),
      ...Object.keys(state.pins).map((c) => loadPins(c).catch(() => {})),
      ...Object.keys(state.bookmarks).map((c) => loadBookmarks(c).catch(() => {})),
      loadViews(),
      loadEmoji(),
      loadCommands(),
    ])
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
        if (event.type === "emoji_changed") for (const pending of emojiLoads) pending.push(event)
        dispatch({ type: "event", event })
        fillIn(event)
        if (event.type === "commands_changed") void loadCommands()
      },
      onStatus(status) {
        dispatch({ type: "connection", status })
        if (status !== "connected") return
        if (active !== undefined) live?.send({ type: "campflare.active", active })
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
      void loadViews()
      void loadEmoji()
      void loadCommands()
    } catch (error) {
      dispatch({ type: "failed", error: error instanceof ApiError ? error.code : String(error) })
      return false
    }
    return true
  }

  /** The emoji_changed events seen while each emoji.list is in flight. */
  const emojiLoads = new Set<RealtimeEvent[]>()

  /** Custom emoji, for drawing :name: as images; emoji_changed keeps them current. Text stands in without them. */
  async function loadEmoji() {
    const during: RealtimeEvent[] = []
    emojiLoads.add(during)
    try {
      const r = await client.call<ApiResult & { emoji: Record<string, string> }>("emoji.list")
      // A change that arrived while the list was in flight may be newer than the list: it goes
      // on top. One the list already has changes nothing when applied again.
      let loaded: WorkspaceState = { ...state, emoji: r.emoji }
      for (const event of during) loaded = applyEvent(loaded, event)
      dispatch({ type: "emoji", emoji: loaded.emoji })
    } catch {
      // A token without emoji:read, or an older server: names show as :name:.
    } finally {
      emojiLoads.delete(during)
    }
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

  /** Calls a method whose "already so" errors mean the change was made already: nothing to report. */
  async function idempotent(method: string, args: Record<string, string>, already: string[]) {
    try {
      await client.call(method, args)
    } catch (error) {
      if (!(error instanceof ApiError && already.includes(error.code))) throw error
    }
  }

  async function loadPins(channel: string) {
    const res = await client.call<ApiResult & { items: PinItem[] }>("pins.list", { channel })
    dispatch({ type: "pins", channel, items: res.items })
  }

  async function setPinned(channel: string, ts: string, pinned: boolean) {
    await idempotent(pinned ? "pins.add" : "pins.remove", { channel, timestamp: ts }, ["already_pinned", "no_pin"])
    const message = state.messages[keyOf(channel, ts)]
    // The event that follows says the same; applying it now shows the change at once.
    if (message) {
      const item: PinItem = { channel, created: Math.floor(Date.now() / 1000), created_by: selfId(), message }
      dispatch({ type: "event", event: { type: pinned ? "pin_added" : "pin_removed", channel_id: channel, item } })
    } else if (state.pins[channel]) await loadPins(channel)
  }

  async function loadBookmarks(channel: string) {
    const res = await client.call<ApiResult & { bookmarks: Bookmark[] }>("bookmarks.list", { channel_id: channel })
    dispatch({ type: "bookmarks", channel, bookmarks: res.bookmarks })
  }

  async function addBookmark(channel: string, link: string, opts: { title?: string; emoji?: string } = {}) {
    const res = await client.call<ApiResult & { bookmark: Bookmark }>("bookmarks.add", {
      channel_id: channel,
      type: "link",
      link,
      title: opts.title ?? link,
      ...(opts.emoji ? { emoji: opts.emoji } : {}),
    })
    dispatch({ type: "event", event: { type: "bookmark_added", channel_id: channel, bookmark: res.bookmark } })
  }

  async function removeBookmark(channel: string, id: string) {
    const bookmark = state.bookmarks[channel]?.find((b) => b.id === id)
    await client.call("bookmarks.remove", { channel_id: channel, bookmark_id: id })
    if (bookmark) dispatch({ type: "event", event: { type: "bookmark_removed", channel_id: channel, bookmark } })
  }

  async function setSaved(channel: string, ts: string, saved: boolean) {
    await idempotent(saved ? "stars.add" : "stars.remove", { channel, timestamp: ts }, [
      "already_starred",
      "not_starred",
    ])
    const item = { type: "message", channel, message: { ts } }
    dispatch({ type: "event", event: { type: saved ? "star_added" : "star_removed", user: selfId(), item } })
  }

  async function click(channel: string, ts: string, { blockId, actionId, value }: Click) {
    await client.call("campflare.blocks.action", {
      channel,
      ts,
      block_id: blockId,
      action_id: actionId,
      ...(value !== undefined ? { value } : {}),
    })
  }

  async function stopStream(channel: string, ts: string) {
    await client.call("campflare.chat.stopStream", { channel, ts })
  }

  async function clickInView(viewId: string, { blockId, actionId, value }: Click, values?: FormValues) {
    await client.call("campflare.blocks.action", {
      view_id: viewId,
      block_id: blockId,
      action_id: actionId,
      ...(value !== undefined ? { value } : {}),
      ...(values ? { values } : {}),
    })
  }

  type ViewsAnswer = ApiResult & { views: View[]; errors?: Record<string, string> }

  async function submitView(viewId: string, values: FormValues) {
    const r = await client.call<ViewsAnswer>("campflare.views.submit", { view_id: viewId, values })
    dispatch({ type: "views", views: r.views })
    return r.errors ? { errors: r.errors } : {}
  }

  async function closeView(viewId: string) {
    // Gone at once (with those on it): a close isn't the app's to refuse, and a view the server lost is closed too.
    const at = state.views.findIndex((v) => v.id === viewId)
    if (at >= 0) dispatch({ type: "views", views: state.views.slice(0, at) })
    const r = await client.call<ViewsAnswer>("campflare.views.close", { view_id: viewId }).catch(() => undefined)
    if (r) dispatch({ type: "views", views: r.views })
  }

  /** The views open for you now: after loading, and after a reconnect (an app may have opened one meanwhile). */
  async function loadViews() {
    const r = await client.call<ViewsAnswer>("campflare.views.list").catch(() => undefined)
    if (r) dispatch({ type: "views", views: r.views })
  }

  async function loadCommands() {
    const r = await client
      .call<ApiResult & { commands: SlashCommand[] }>("campflare.commands.list")
      .catch(() => undefined)
    if (r) dispatch({ type: "commands", commands: r.commands })
  }

  async function invokeCommand(channel: string, command: string, text: string) {
    const r = await client.call<ApiResult & { response?: CommandResponse }>("campflare.commands.invoke", {
      channel,
      command,
      text,
    })
    return r.response
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

  function setActive(value: boolean) {
    active = value
    live?.send({ type: "campflare.active", active })
  }

  async function pushKey() {
    try {
      return (await client.call<ApiResult & { key: string }>("campflare.push.vapidKey")).key
    } catch (error) {
      if (error instanceof ApiError && error.code === "push_not_configured") return null
      throw error
    }
  }

  async function subscribePush(subscription: PushSubscriptionInfo, label: string) {
    // As JSON: the subscription is an object, and a form would flatten it.
    await client.call("campflare.push.subscribe", { subscription: JSON.stringify(subscription), label })
  }

  async function unsubscribePush(endpoint: string) {
    try {
      await client.call("campflare.push.unsubscribe", { endpoint })
    } catch (error) {
      if (!(error instanceof ApiError && error.code === "subscription_not_found")) throw error
    }
  }

  async function testPush() {
    const r = await client.call<ApiResult & { sent: number; failed: number; removed: number }>("campflare.push.test")
    return { sent: r.sent, failed: r.failed, removed: r.removed }
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
    loadPins,
    setPinned,
    loadBookmarks,
    addBookmark,
    removeBookmark,
    setSaved,
    click,
    stopStream,
    clickInView,
    submitView,
    closeView,
    loadCommands,
    invokeCommand,
    markRead,
    join,
    createChannel,
    openDm,
    setActive,
    pushKey,
    subscribePush,
    unsubscribePush,
    testPush,
  }
}
