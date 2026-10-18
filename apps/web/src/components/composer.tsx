import {
  commandIn,
  commandSuggestions,
  formatBytes,
  type NewFile,
  pastedFileName,
  type SlashCommand,
} from "@campflare/core"
import { PaperclipIcon, SendHorizontalIcon, XIcon } from "lucide-react"
import {
  type ClipboardEvent,
  type DragEvent,
  type KeyboardEvent,
  type Ref,
  useId,
  useImperativeHandle,
  useRef,
  useState,
} from "react"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { cn } from "@/lib/utils"
import { useWorkspace, useWorkspaceState } from "@/workspace"
import { reportError } from "./message"

export interface ComposerHandle {
  /** Adds files to send with the next message (from a drop elsewhere in the conversation). */
  attach(files: File[]): void
}

export interface ComposerProps {
  channel: string
  threadTs?: string
  placeholder: string
  disabled?: boolean
  ref?: Ref<ComposerHandle>
}

const hasFiles = (e: DragEvent) => Boolean(e.dataTransfer?.types.includes("Files"))

/** Drag-and-drop of files onto an element: its handlers, and whether files are over it now. */
export function useFileDrop(onFiles: (files: File[]) => void) {
  const [dragging, setDragging] = useState(false)
  return {
    dragging,
    handlers: {
      onDragOver(e: DragEvent) {
        if (!hasFiles(e)) return
        // Without this the browser would open the file in place of the app.
        e.preventDefault()
        setDragging(true)
      },
      onDragLeave(e: DragEvent) {
        if (e.currentTarget.contains(e.relatedTarget as Node | null)) return
        setDragging(false)
      },
      onDrop(e: DragEvent) {
        if (!hasFiles(e)) return
        e.preventDefault()
        setDragging(false)
        onFiles([...e.dataTransfer.files])
      },
    },
  }
}

/**
 * The files a paste carries, named sensibly when the clipboard gave a generic name. None when it
 * carries plain text too: office apps put a picture of copied cells or slides beside their text,
 * and the text is what was meant.
 */
export function pastedFiles(data: DataTransfer | null, when = new Date()): File[] {
  if (!data || data.files.length === 0 || data.getData("text/plain")) return []
  return [...data.files].map((f, i) => {
    const name = pastedFileName(f.name, f.type, when, i)
    return name === f.name ? f : new File([f], name, { type: f.type, lastModified: f.lastModified })
  })
}

const readFile = async (f: File): Promise<NewFile> => ({
  name: f.name,
  type: f.type || undefined,
  bytes: new Uint8Array(await f.arrayBuffer()),
})

/** The commands offered while a slash command's name is typed: a listbox the arrow keys move through. */
function CommandList({
  id,
  commands,
  active,
  onPick,
}: {
  id: string
  commands: SlashCommand[]
  active: number
  onPick: (c: SlashCommand) => void
}) {
  return (
    <div
      id={id}
      role="listbox"
      aria-label="Commands"
      className="flex flex-col rounded-md border bg-popover py-1 text-sm"
    >
      {commands.map((c, i) => (
        <div
          key={c.command}
          id={`${id}-${i}`}
          role="option"
          aria-selected={i === active}
          tabIndex={-1}
          className={cn("flex cursor-pointer items-baseline gap-2 px-3 py-1", i === active && "bg-accent")}
          // Before the textarea's blur: picking keeps the focus where typing goes on.
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => onPick(c)}
          onKeyDown={(e) => {
            if (e.key === "Enter") onPick(c)
          }}
        >
          <span className="font-medium">{c.command}</span>
          {c.usage_hint && <span className="text-muted-foreground">{c.usage_hint}</span>}
          <span className="truncate text-muted-foreground">{c.description}</span>
          {c.app_name && <span className="ml-auto shrink-0 text-xs text-muted-foreground">{c.app_name}</span>}
        </div>
      ))}
    </div>
  )
}

/**
 * Enter sends, Shift+Enter breaks the line. Enter that confirms an IME composition (CJK input) does neither.
 * Attached files (the paperclip, or a drop) go with the message as an upload. In a conversation
 * (not a thread), a draft that starts with an app's /command runs it instead of being sent; while
 * the command's name is typed the matching ones are offered (arrows move, Tab or Enter picks).
 */
export function Composer({ channel, threadTs, placeholder, disabled, ref }: ComposerProps) {
  const workspace = useWorkspace()
  const [text, setText] = useState("")
  const [files, setFiles] = useState<File[]>([])
  const picker = useRef<HTMLInputElement>(null)
  const commands = useWorkspaceState((s) => s.commands)
  const listId = useId()
  const [active, setActive] = useState(0)
  const [dismissed, setDismissed] = useState<string>()
  /** A command on its way to its app: the draft stays (read-only) until it's taken, and comes back if it fails. */
  const [running, setRunning] = useState(false)
  // Commands run in the conversation, as on Slack: a thread's composer sends text as it is.
  const offered = threadTs || dismissed === text ? [] : commandSuggestions(text, commands)
  const highlighted = Math.min(active, offered.length - 1)

  const attach = (more: File[]) => {
    if (!disabled && more.length > 0) setFiles((current) => [...current, ...more])
  }
  useImperativeHandle(ref, () => ({ attach }))
  const drop = useFileDrop(attach)

  const pick = (c: SlashCommand) => {
    setText(`${c.command} `)
    setActive(0)
  }

  const send = () => {
    if (running || (!text.trim() && files.length === 0)) return
    const command = threadTs || files.length > 0 ? undefined : commandIn(text, commands)
    if (command) {
      // The app's answer comes as a message (only you see an ephemeral one). A failure is a toast, and the
      // draft is still there to fix or send again.
      setRunning(true)
      workspace
        .invokeCommand(channel, command.command, command.text)
        .then(() => setText(""), reportError(`run ${command.command}`))
        .finally(() => setRunning(false))
      return
    }
    setText("")
    if (files.length > 0) {
      setFiles([])
      Promise.all(files.map(readFile))
        .then((list) => workspace.upload(channel, list, { text: text.trim() ? text : undefined, threadTs }))
        .catch(reportError("read the files"))
      return
    }
    // A failure stays on the message itself, with Retry; nothing to catch here.
    void workspace.send(channel, text, { threadTs })
  }

  const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    const pasted = pastedFiles(e.clipboardData)
    if (pasted.length === 0) return
    // The files would otherwise be dropped, or pasted as their names.
    e.preventDefault()
    attach(pasted)
  }

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    // keyCode 229: Safari reports the composition's Enter that way, with isComposing already false.
    if (e.nativeEvent.isComposing || e.keyCode === 229) return
    if (offered.length > 0) {
      const move = e.key === "ArrowDown" ? 1 : e.key === "ArrowUp" ? -1 : 0
      if (move) {
        e.preventDefault()
        setActive((highlighted + move + offered.length) % offered.length)
        return
      }
      if (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey && commandIn(text, commands) === undefined)) {
        e.preventDefault()
        pick(offered[highlighted]!)
        return
      }
      if (e.key === "Escape") {
        e.preventDefault()
        setDismissed(text)
        return
      }
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault()
      send()
    }
  }

  return (
    <form
      className={cn("flex flex-col gap-2 border-t p-3", drop.dragging && "bg-muted/50")}
      onSubmit={(e) => {
        e.preventDefault()
        send()
      }}
      {...drop.handlers}
    >
      {offered.length > 0 && <CommandList id={listId} commands={offered} active={highlighted} onPick={pick} />}
      {files.length > 0 && (
        <ul aria-label="Attachments" className="flex flex-wrap gap-2">
          {files.map((f, i) => (
            <li
              key={`${i}-${f.name}`}
              className="flex max-w-60 items-center gap-1 rounded-md border bg-muted/50 py-0.5 pr-0.5 pl-2 text-xs"
            >
              <span className="truncate">{f.name}</span>
              <span className="shrink-0 text-muted-foreground">{formatBytes(f.size)}</span>
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label={`Remove ${f.name}`}
                onClick={() => setFiles((current) => current.filter((_, j) => j !== i))}
              >
                <XIcon />
              </Button>
            </li>
          ))}
        </ul>
      )}
      <div className="flex items-end gap-2">
        <input
          ref={picker}
          type="file"
          multiple
          hidden
          aria-label="Files to attach"
          onChange={(e) => {
            attach([...(e.target.files ?? [])])
            e.target.value = ""
          }}
        />
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label="Attach files"
          disabled={disabled}
          onClick={() => picker.current?.click()}
        >
          <PaperclipIcon />
        </Button>
        <Textarea
          aria-label={placeholder}
          placeholder={placeholder}
          value={text}
          disabled={disabled}
          readOnly={running}
          aria-busy={running || undefined}
          rows={1}
          className="max-h-48 min-h-9 resize-none"
          aria-autocomplete={commands.length > 0 && !threadTs ? "list" : undefined}
          aria-controls={offered.length > 0 ? listId : undefined}
          aria-activedescendant={offered.length > 0 ? `${listId}-${highlighted}` : undefined}
          onChange={(e) => {
            setText(e.target.value)
            setActive(0)
          }}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
        />
        <Button
          type="submit"
          size="icon"
          aria-label="Send"
          disabled={disabled || running || (!text.trim() && files.length === 0)}
        >
          <SendHorizontalIcon />
        </Button>
      </div>
    </form>
  )
}
