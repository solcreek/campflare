import { SendHorizontalIcon } from "lucide-react"
import { type KeyboardEvent, useState } from "react"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { useWorkspace } from "@/workspace"

export interface ComposerProps {
  channel: string
  threadTs?: string
  placeholder: string
  disabled?: boolean
}

/** Enter sends, Shift+Enter breaks the line. Enter that confirms an IME composition (CJK input) does neither. */
export function Composer({ channel, threadTs, placeholder, disabled }: ComposerProps) {
  const workspace = useWorkspace()
  const [text, setText] = useState("")

  const send = () => {
    if (!text.trim()) return
    setText("")
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
      className="flex items-end gap-2 border-t p-3"
      onSubmit={(e) => {
        e.preventDefault()
        send()
      }}
    >
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
      <Button type="submit" size="icon" aria-label="Send" disabled={disabled || !text.trim()}>
        <SendHorizontalIcon />
      </Button>
    </form>
  )
}
