import type { Message } from "@campflare/core"
import { useLayoutEffect, useRef } from "react"
import { Button } from "@/components/ui/button"
import { MessageItem } from "./message"

/** Consecutive messages from one person within five minutes read as one block. */
export function isGrouped(previous: Message | undefined, message: Message): boolean {
  if (!previous || !message.user || previous.user !== message.user) return false
  if (previous.subtype || message.subtype || (previous.reply_count ?? 0) > 0) return false
  if (message.pending || previous.pending) return Boolean(message.pending)
  return Number(message.ts) - Number(previous.ts) < 300
}

export interface MessageListProps {
  messages: Message[]
  hasMore?: boolean
  onLoadOlder?: () => void
  inThread?: boolean
  onOpenThread?: (ts: string) => void
  empty?: string
}

export function MessageList({ messages, hasMore, onLoadOlder, inThread, onOpenThread, empty }: MessageListProps) {
  const scroller = useRef<HTMLDivElement>(null)
  const pinned = useRef(true)
  const newest = messages.at(-1)?.ts
  const followed = useRef<string>(undefined)

  // Follow new messages while the reader is at the bottom; leave them be while they read older ones.
  useLayoutEffect(() => {
    const el = scroller.current
    if (!el || newest === followed.current) return
    followed.current = newest
    if (pinned.current) el.scrollTop = el.scrollHeight
  }, [newest])

  return (
    <div
      ref={scroller}
      role="log"
      aria-label="Messages"
      className="min-h-0 flex-1 overflow-y-auto pb-2"
      onScroll={(e) => {
        const el = e.currentTarget
        pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40
      }}
    >
      {hasMore && onLoadOlder && (
        <div className="flex justify-center p-2">
          <Button variant="ghost" size="sm" onClick={onLoadOlder}>
            Load older messages
          </Button>
        </div>
      )}
      {messages.length === 0 && empty && <p className="p-4 text-sm text-muted-foreground">{empty}</p>}
      {messages.map((m, i) => (
        <MessageItem
          key={m.ts}
          message={m}
          grouped={isGrouped(messages[i - 1], m)}
          inThread={inThread}
          onOpenThread={onOpenThread}
        />
      ))}
    </div>
  )
}
