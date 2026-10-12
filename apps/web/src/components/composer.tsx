import { formatBytes, type NewFile } from "@campflare/core"
import { PaperclipIcon, SendHorizontalIcon, XIcon } from "lucide-react"
import { type DragEvent, type KeyboardEvent, type Ref, useImperativeHandle, useRef, useState } from "react"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { cn } from "@/lib/utils"
import { useWorkspace } from "@/workspace"
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

const readFile = async (f: File): Promise<NewFile> => ({
  name: f.name,
  type: f.type || undefined,
  bytes: new Uint8Array(await f.arrayBuffer()),
})

/**
 * Enter sends, Shift+Enter breaks the line. Enter that confirms an IME composition (CJK input) does neither.
 * Attached files (the paperclip, or a drop) go with the message as an upload.
 */
export function Composer({ channel, threadTs, placeholder, disabled, ref }: ComposerProps) {
  const workspace = useWorkspace()
  const [text, setText] = useState("")
  const [files, setFiles] = useState<File[]>([])
  const picker = useRef<HTMLInputElement>(null)

  const attach = (more: File[]) => {
    if (!disabled && more.length > 0) setFiles((current) => [...current, ...more])
  }
  useImperativeHandle(ref, () => ({ attach }))
  const drop = useFileDrop(attach)

  const send = () => {
    if (!text.trim() && files.length === 0) return
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

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    // keyCode 229: Safari reports the composition's Enter that way, with isComposing already false.
    if (e.nativeEvent.isComposing || e.keyCode === 229) return
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
          rows={1}
          className="max-h-48 min-h-9 resize-none"
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
        />
        <Button type="submit" size="icon" aria-label="Send" disabled={disabled || (!text.trim() && files.length === 0)}>
          <SendHorizontalIcon />
        </Button>
      </div>
    </form>
  )
}
