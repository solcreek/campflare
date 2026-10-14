import { conversationTitle, keyOf } from "@campflare/core"
import { HashIcon, LockIcon, XIcon } from "lucide-react"
import { useEffect, useMemo, useRef, useState } from "react"
import { Button } from "@/components/ui/button"
import { useWorkspace, useWorkspaceState } from "@/workspace"
import { Composer, type ComposerHandle, useFileDrop } from "./composer"
import { reportError } from "./message"
import { MessageList } from "./message-list"
import { MissingMessage, NotFoundView } from "./not-found"
import { ThreadStatusLine } from "./thread-status"

/** Over a conversation while files are dragged across it. */
function DropHint() {
  return (
    <div className="pointer-events-none absolute inset-2 z-10 flex items-center justify-center rounded-lg border-2 border-dashed border-primary/50 bg-background/80 text-sm font-medium">
      Drop files to attach them
    </div>
  )
}

export interface ConversationViewProps {
  channel: string
  onOpenThread: (ts: string) => void
  /** The ts of a message a link points at: older pages load until it's there, then it's highlighted. */
  highlight?: string
  /** Drops the highlight (the "not here" notice's Dismiss). */
  onClearHighlight?: () => void
  /** Leaves a conversation that isn't there. */
  onLeave?: () => void
}

export function ConversationView({
  channel,
  onOpenThread,
  highlight,
  onClearHighlight,
  onLeave,
}: ConversationViewProps) {
  const workspace = useWorkspace()
  const conversation = useWorkspaceState((s) => s.conversations[channel])
  const known = Boolean(conversation)
  const title = useWorkspaceState((s) => (conversation ? conversationTitle(s, conversation) : channel))
  const line = useWorkspaceState((s) => s.timelines[channel])
  const messagesById = useWorkspaceState((s) => s.messages)
  const messages = useMemo(() => (line?.keys ?? []).flatMap((k) => messagesById[k] ?? []), [line, messagesById])
  const loaded = Boolean(line)
  const newest = messages.findLast((m) => !m.pending)?.ts
  const oldest = messages.find((m) => !m.pending)?.ts
  // A linked message older than what's loaded: page back until it's in, or there's nothing older.
  const found = Boolean(highlight && messages.some((m) => m.ts === highlight))
  const seeking = Boolean(highlight && loaded && !found && line?.hasMore && Number(oldest) > Number(highlight))
  const missing = Boolean(highlight && loaded && !found && !seeking)
  const composer = useRef<ComposerHandle>(null)
  const drop = useFileDrop((files) => composer.current?.attach(files))

  useEffect(() => {
    // Not for a conversation that isn't there: the not-found view says so, without an error toast too.
    if (!loaded && known) workspace.loadHistory(channel).catch(reportError("load messages"))
  }, [workspace, channel, loaded, known])

  // Again for each page that comes in (oldest moves) while the message is still further back.
  useEffect(() => {
    if (seeking && oldest) workspace.loadHistory(channel, { older: true }).catch(reportError("load messages"))
  }, [workspace, channel, seeking, oldest])

  // Reading a conversation marks it read, up to what's on screen.
  useEffect(() => {
    if (newest) workspace.markRead(channel).catch(() => {})
  }, [workspace, channel, newest])

  if (!conversation)
    return (
      <NotFoundView title="Conversation not found" onBack={() => onLeave?.()}>
        There's no conversation here that you can see: it may be private, or the link may be from another workspace.
      </NotFoundView>
    )
  const isDm = conversation.is_im || conversation.is_mpim
  const canJoin = !isDm && conversation.is_member === false

  return (
    <section aria-label={title} className="relative flex min-h-0 min-w-0 flex-1 flex-col" {...drop.handlers}>
      {drop.dragging && <DropHint />}
      <header className="flex h-12 shrink-0 items-center gap-2 border-b px-4">
        {!isDm && (conversation.is_private ? <LockIcon className="size-4" /> : <HashIcon className="size-4" />)}
        <h1 className="font-semibold">{title}</h1>
        {conversation.topic?.value && (
          <p className="truncate text-sm text-muted-foreground">{conversation.topic.value}</p>
        )}
      </header>
      {missing && (
        <MissingMessage onDismiss={() => onClearHighlight?.()}>
          The linked message isn't here: it may have been deleted.
        </MissingMessage>
      )}
      <MessageList
        messages={messages}
        highlight={highlight}
        hasMore={line?.hasMore}
        onLoadOlder={() => workspace.loadHistory(channel, { older: true }).catch(reportError("load messages"))}
        onOpenThread={onOpenThread}
        empty={loaded && !seeking ? "No messages yet." : "Loading…"}
      />
      {canJoin ? (
        <div className="flex items-center justify-center gap-3 border-t p-3 text-sm">
          You're viewing #{title}.
          <Button size="sm" onClick={() => workspace.join(channel).catch(reportError("join"))}>
            Join channel
          </Button>
        </div>
      ) : (
        <Composer
          ref={composer}
          channel={channel}
          placeholder={isDm ? `Message ${title}` : `Message #${title}`}
          disabled={conversation.is_archived}
        />
      )}
    </section>
  )
}

export function ThreadPanel({
  channel,
  threadTs,
  onClose,
  highlight,
  onClearHighlight,
}: {
  channel: string
  threadTs: string
  onClose: () => void
  /** The ts of a reply a link points at, highlighted. */
  highlight?: string
  onClearHighlight?: () => void
}) {
  const workspace = useWorkspace()
  const key = keyOf(channel, threadTs)
  const composer = useRef<ComposerHandle>(null)
  const drop = useFileDrop((files) => composer.current?.attach(files))
  const parent = useWorkspaceState((s) => s.messages[key])
  const replies = useWorkspaceState((s) => s.threads[key])
  const messagesById = useWorkspaceState((s) => s.messages)
  const messages = useMemo(
    () => [...(parent ? [parent] : []), ...(replies?.keys ?? []).flatMap((k) => messagesById[k] ?? [])],
    [parent, replies, messagesById],
  )

  const [load, setLoad] = useState<"loading" | "loaded" | "gone">("loading")
  useEffect(() => {
    let live = true
    workspace.loadReplies(channel, threadTs).then(
      () => live && setLoad("loaded"),
      (error: unknown) => {
        if (!live) return
        const code = error && typeof error === "object" && "code" in error ? error.code : undefined
        if (code === "message_not_found" || code === "thread_not_found") setLoad("gone")
        else reportError("load the thread")(error)
      },
    )
    return () => {
      live = false
    }
  }, [workspace, channel, threadTs])
  const missing = Boolean(highlight && load === "loaded" && !messages.some((m) => m.ts === highlight))

  return (
    <aside aria-label="Thread" className="relative flex min-h-0 w-96 shrink-0 flex-col border-l" {...drop.handlers}>
      {drop.dragging && <DropHint />}
      <header className="flex h-12 shrink-0 items-center justify-between border-b px-4">
        <h2 className="font-semibold">Thread</h2>
        <Button variant="ghost" size="icon-sm" aria-label="Close thread" onClick={onClose}>
          <XIcon />
        </Button>
      </header>
      {load === "gone" ? (
        <p role="status" className="p-4 text-sm text-muted-foreground">
          This thread isn't here: it may have been deleted, or the link is wrong.
        </p>
      ) : (
        <>
          {missing && (
            <MissingMessage onDismiss={() => onClearHighlight?.()}>
              The linked reply isn't in this thread: it may have been deleted.
            </MissingMessage>
          )}
          <MessageList messages={messages} inThread empty="Loading…" highlight={highlight} />
          <ThreadStatusLine channel={channel} threadTs={threadTs} />
          <Composer ref={composer} channel={channel} threadTs={threadTs} placeholder="Reply…" />
        </>
      )}
    </aside>
  )
}
