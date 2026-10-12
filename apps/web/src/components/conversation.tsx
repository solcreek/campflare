import { conversationTitle, keyOf } from "@campflare/core"
import { HashIcon, LockIcon, XIcon } from "lucide-react"
import { useEffect, useMemo } from "react"
import { Button } from "@/components/ui/button"
import { useWorkspace, useWorkspaceState } from "@/workspace"
import { Composer } from "./composer"
import { reportError } from "./message"
import { MessageList } from "./message-list"

export function ConversationView({ channel, onOpenThread }: { channel: string; onOpenThread: (ts: string) => void }) {
  const workspace = useWorkspace()
  const conversation = useWorkspaceState((s) => s.conversations[channel])
  const title = useWorkspaceState((s) => (conversation ? conversationTitle(s, conversation) : channel))
  const line = useWorkspaceState((s) => s.timelines[channel])
  const messagesById = useWorkspaceState((s) => s.messages)
  const messages = useMemo(() => (line?.keys ?? []).flatMap((k) => messagesById[k] ?? []), [line, messagesById])
  const loaded = Boolean(line)
  const newest = messages.findLast((m) => !m.pending)?.ts

  useEffect(() => {
    if (!loaded) workspace.loadHistory(channel).catch(reportError("load messages"))
  }, [workspace, channel, loaded])

  // Reading a conversation marks it read, up to what's on screen.
  useEffect(() => {
    if (newest) workspace.markRead(channel).catch(() => {})
  }, [workspace, channel, newest])

  if (!conversation) return <p className="p-6 text-muted-foreground">Conversation not found.</p>
  const isDm = conversation.is_im || conversation.is_mpim
  const canJoin = !isDm && conversation.is_member === false

  return (
    <section aria-label={title} className="flex min-h-0 min-w-0 flex-1 flex-col">
      <header className="flex h-12 shrink-0 items-center gap-2 border-b px-4">
        {!isDm && (conversation.is_private ? <LockIcon className="size-4" /> : <HashIcon className="size-4" />)}
        <h1 className="font-semibold">{title}</h1>
        {conversation.topic?.value && (
          <p className="truncate text-sm text-muted-foreground">{conversation.topic.value}</p>
        )}
      </header>
      <MessageList
        messages={messages}
        hasMore={line?.hasMore}
        onLoadOlder={() => workspace.loadHistory(channel, { older: true }).catch(reportError("load messages"))}
        onOpenThread={onOpenThread}
        empty={loaded ? "No messages yet." : "Loading…"}
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
}: {
  channel: string
  threadTs: string
  onClose: () => void
}) {
  const workspace = useWorkspace()
  const key = keyOf(channel, threadTs)
  const parent = useWorkspaceState((s) => s.messages[key])
  const replies = useWorkspaceState((s) => s.threads[key])
  const messagesById = useWorkspaceState((s) => s.messages)
  const messages = useMemo(
    () => [...(parent ? [parent] : []), ...(replies?.keys ?? []).flatMap((k) => messagesById[k] ?? [])],
    [parent, replies, messagesById],
  )

  useEffect(() => {
    workspace.loadReplies(channel, threadTs).catch(reportError("load the thread"))
  }, [workspace, channel, threadTs])

  return (
    <aside aria-label="Thread" className="flex min-h-0 w-96 shrink-0 flex-col border-l">
      <header className="flex h-12 shrink-0 items-center justify-between border-b px-4">
        <h2 className="font-semibold">Thread</h2>
        <Button variant="ghost" size="icon-sm" aria-label="Close thread" onClick={onClose}>
          <XIcon />
        </Button>
      </header>
      <MessageList messages={messages} inThread empty="Loading…" />
      <Composer channel={channel} threadTs={threadTs} placeholder="Reply…" />
    </aside>
  )
}
