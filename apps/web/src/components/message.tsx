import { commonEmoji, displayName, type Message } from "@campflare/core"
import { MessageSquareIcon, PencilIcon, SmilePlusIcon, Trash2Icon } from "lucide-react"
import { type KeyboardEvent, useEffect, useRef, useState } from "react"
import { toast } from "sonner"
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import { Button } from "@/components/ui/button"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Textarea } from "@/components/ui/textarea"
import { cn } from "@/lib/utils"
import { useWorkspace, useWorkspaceState } from "@/workspace"
import { Emoji, Mrkdwn } from "./mrkdwn"

/** Messages the server writes about a conversation, shown as one quiet line. */
export const SYSTEM_SUBTYPES = new Set([
  "channel_join",
  "channel_leave",
  "channel_topic",
  "channel_purpose",
  "channel_name",
  "channel_archive",
  "channel_unarchive",
])

export function formatTime(ts: string): string {
  return new Date(Number(ts) * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
}

/** Reports a failed action as a toast; the store has already put things back. */
export function reportError(action: string) {
  return (error: unknown) => {
    const code = error && typeof error === "object" && "code" in error ? String(error.code) : String(error)
    toast.error(`Couldn't ${action}: ${code}`)
  }
}

function ReactionPicker({ onPick }: { onPick: (name: string) => void }) {
  const [open, setOpen] = useState(false)
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger render={<Button variant="ghost" size="icon-sm" aria-label="Add reaction" />}>
        <SmilePlusIcon />
      </PopoverTrigger>
      <PopoverContent className="flex w-auto gap-1 p-1">
        {commonEmoji.map((name) => (
          <Button
            key={name}
            variant="ghost"
            size="icon-sm"
            aria-label={`React with ${name}`}
            onClick={() => {
              setOpen(false)
              onPick(name)
            }}
          >
            <Emoji name={name} />
          </Button>
        ))}
      </PopoverContent>
    </Popover>
  )
}

function Editor({ message, onDone }: { message: Message; onDone: () => void }) {
  const workspace = useWorkspace()
  const [text, setText] = useState(message.text ?? "")
  const field = useRef<HTMLTextAreaElement>(null)
  // Choosing Edit moves focus into the editor, as it would for any inline editor.
  useEffect(() => field.current?.focus(), [])
  const save = () => {
    onDone()
    if (text.trim() && text !== message.text)
      workspace.edit(message.channel, message.ts, text).catch(reportError("edit the message"))
  }
  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.nativeEvent.isComposing) return
    if (e.key === "Escape") onDone()
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault()
      save()
    }
  }
  return (
    <div className="space-y-1">
      <Textarea
        aria-label="Edit message"
        value={text}
        ref={field}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={onKeyDown}
      />
      <div className="flex gap-1">
        <Button size="sm" onClick={save}>
          Save
        </Button>
        <Button size="sm" variant="ghost" onClick={onDone}>
          Cancel
        </Button>
      </div>
    </div>
  )
}

export interface MessageItemProps {
  message: Message
  /** Follows a message from the same person moments before: no avatar or name. */
  grouped?: boolean
  /** Shown inside a thread: no thread summary. */
  inThread?: boolean
  onOpenThread?: (ts: string) => void
}

export function MessageItem({ message, grouped, inThread, onOpenThread }: MessageItemProps) {
  const workspace = useWorkspace()
  const author = useWorkspaceState((s) => (message.user ? s.users[message.user] : undefined))
  const selfId = useWorkspaceState((s) => s.self?.userId)
  const [editing, setEditing] = useState(false)
  const mine = Boolean(selfId && message.user === selfId)
  const name = message.user ? displayName(author) : ((message.username as string | undefined) ?? "bot")
  const live = !message.pending && message.subtype !== "tombstone" && !message.is_ephemeral
  const react = (reaction: string) =>
    workspace.toggleReaction(message.channel, message.ts, reaction).catch(reportError("react"))

  if (message.subtype && SYSTEM_SUBTYPES.has(message.subtype)) {
    // Joins name the person in their text ("<@U1> has joined the channel"); the others don't.
    const text = message.text ?? ""
    return (
      <article
        aria-label={`${name} at ${formatTime(message.ts)}`}
        className="flex items-baseline gap-2 px-4 py-0.5 pl-15 text-sm text-muted-foreground"
      >
        {!text.includes("<@") && <span className="font-medium">{name}</span>}
        <Mrkdwn text={text} />
        <time className="text-xs">{formatTime(message.ts)}</time>
      </article>
    )
  }

  return (
    <article
      aria-label={`${name} at ${message.pending ? "sending" : formatTime(message.ts)}`}
      className={cn(
        "group relative flex gap-2 px-4 py-0.5 hover:bg-muted/50",
        !grouped && "mt-2 pt-1",
        message.pending && !message.failed && "opacity-60",
      )}
    >
      <div className="w-9 shrink-0">
        {!grouped && (
          <Avatar className="size-9 rounded-md after:rounded-md">
            <AvatarImage src={author?.profile?.image_72} alt="" className="rounded-md" />
            <AvatarFallback className="rounded-md">{name.slice(0, 1).toUpperCase()}</AvatarFallback>
          </Avatar>
        )}
      </div>
      <div className="min-w-0 flex-1">
        {!grouped && (
          <div className="flex items-baseline gap-2">
            <span className="font-semibold">{name}</span>
            {!message.pending && <time className="text-xs text-muted-foreground">{formatTime(message.ts)}</time>}
            {message.is_ephemeral && <span className="text-xs text-muted-foreground">Only visible to you</span>}
          </div>
        )}
        {editing ? (
          <Editor message={message} onDone={() => setEditing(false)} />
        ) : (
          <div className={cn(message.subtype === "tombstone" && "text-muted-foreground italic")}>
            <Mrkdwn text={message.text ?? ""} />
            {message.edited && <span className="text-xs text-muted-foreground"> (edited)</span>}
          </div>
        )}
        {message.failed && (
          <div role="alert" className="mt-1 flex items-center gap-2 text-sm text-destructive">
            Not sent ({message.failed}).
            <Button size="xs" variant="outline" onClick={() => void workspace.retry(message.channel, message.ts)}>
              Retry
            </Button>
            <Button size="xs" variant="ghost" onClick={() => workspace.discard(message.channel, message.ts)}>
              Discard
            </Button>
          </div>
        )}
        {(message.reactions?.length ?? 0) > 0 && (
          <div className="mt-1 flex flex-wrap gap-1">
            {message.reactions!.map((r) => {
              const reacted = Boolean(selfId && r.users.includes(selfId))
              return (
                <button
                  key={r.name}
                  type="button"
                  aria-pressed={reacted}
                  aria-label={`${r.name}, ${r.count}`}
                  onClick={() => void react(r.name)}
                  className={cn(
                    "flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs",
                    reacted ? "border-primary/50 bg-primary/10" : "bg-muted/50 hover:bg-muted",
                  )}
                >
                  <Emoji name={r.name} />
                  <span>{r.count}</span>
                </button>
              )
            })}
          </div>
        )}
        {!inThread && (message.reply_count ?? 0) > 0 && (
          <button
            type="button"
            onClick={() => onOpenThread?.(message.ts)}
            className="mt-1 text-xs font-medium text-link hover:underline"
          >
            {message.reply_count === 1 ? "1 reply" : `${message.reply_count} replies`}
          </button>
        )}
      </div>
      {live && !editing && (
        <div
          role="toolbar"
          aria-label="Message actions"
          className="absolute -top-3 right-4 hidden rounded-md border bg-background shadow-sm group-focus-within:flex group-hover:flex"
        >
          <ReactionPicker onPick={(n) => void react(n)} />
          {!inThread && onOpenThread && (
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Reply in thread"
              onClick={() => onOpenThread(message.ts)}
            >
              <MessageSquareIcon />
            </Button>
          )}
          {mine && (
            <>
              <Button variant="ghost" size="icon-sm" aria-label="Edit message" onClick={() => setEditing(true)}>
                <PencilIcon />
              </Button>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="Delete message"
                onClick={() => workspace.remove(message.channel, message.ts).catch(reportError("delete the message"))}
              >
                <Trash2Icon />
              </Button>
            </>
          )}
        </div>
      )}
    </article>
  )
}
