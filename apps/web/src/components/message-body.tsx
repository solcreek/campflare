import { planOf, taskOf, type Message, type MessageBlock, type Task } from "@campflare/core"
import { SquareIcon } from "lucide-react"
import { useState } from "react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { useWorkspace } from "@/workspace"
import { PlanView, TaskList } from "./message-tasks"
import { Markdown, Mrkdwn } from "./mrkdwn"

// What a message says. Text is mrkdwn; a message with markdown, task_card or
// plan blocks (what an app streams with chat.startStream, or posts as such
// blocks) shows its blocks instead, in order: markdown, tasks and plans, and
// the text of sections, headers and context. Blocks that act (buttons,
// feedback buttons) are MessageBlocks's.

interface TextObject {
  type?: string
  text?: unknown
}

const textObject = (value: unknown): TextObject | undefined =>
  value && typeof value === "object" ? (value as TextObject) : undefined

function TextOf({ value }: { value: unknown }) {
  const t = textObject(value)
  if (typeof t?.text !== "string") return null
  return t.type === "mrkdwn" ? <Mrkdwn text={t.text} /> : <p className="whitespace-pre-wrap">{t.text}</p>
}

function BlockView({ block }: { block: MessageBlock }) {
  switch (block.type) {
    case "markdown":
      return typeof block.text === "string" ? <Markdown text={block.text} /> : null
    case "section":
      return <TextOf value={block.text} />
    case "header":
      return (
        <div className="text-lg font-semibold">
          <TextOf value={block.text} />
        </div>
      )
    case "context": {
      const elements = Array.isArray(block.elements) ? (block.elements as unknown[]) : []
      return (
        <div className="text-xs text-muted-foreground">
          {elements.map((e, i) => (
            <TextOf key={i} value={e} />
          ))}
        </div>
      )
    }
    case "divider":
      return <hr className="my-2" />
    case "plan": {
      const plan = planOf(block)
      return plan ? <PlanView plan={plan} /> : null
    }
    default:
      return null
  }
}

/** The blocks to show in order, with consecutive task cards as one list. */
function pieces(blocks: MessageBlock[]): (MessageBlock | Task[])[] {
  const out: (MessageBlock | Task[])[] = []
  for (const block of blocks) {
    const task = taskOf(block)
    const last = out.at(-1)
    if (!task) out.push(block)
    else if (Array.isArray(last)) last.push(task)
    else out.push([task])
  }
  return out
}

const SHOWN = new Set(["markdown", "task_card", "plan"])

/** Whether a message reads from its blocks rather than its text. */
export const showsBlocks = (m: Pick<Message, "blocks">) => Boolean(m.blocks?.some((b) => SHOWN.has(b.type)))

/** Stops an app's reply that is still being written, as Slack's stop button does. */
function StopStream({ message }: { message: Message }) {
  const workspace = useWorkspace()
  const [stopping, setStopping] = useState(false)
  const stop = () => {
    setStopping(true)
    workspace.stopStream(message.channel, message.ts).catch((error: unknown) => {
      setStopping(false)
      const code = error && typeof error === "object" && "code" in error ? String(error.code) : String(error)
      toast.error(`Couldn't stop the reply: ${code}`)
    })
  }
  return (
    <Button size="xs" variant="outline" disabled={stopping} onClick={stop} aria-label="Stop writing">
      <SquareIcon aria-hidden className="fill-current" />
      Stop
    </Button>
  )
}

export function MessageBody({ message }: { message: Message }) {
  const streaming = message.streaming_state === "in_progress"
  return (
    <>
      {showsBlocks(message) ? (
        <div className="space-y-1">
          {pieces(message.blocks!).map((piece, i) =>
            Array.isArray(piece) ? <TaskList key={i} tasks={piece} /> : <BlockView key={i} block={piece} />,
          )}
        </div>
      ) : (
        <Mrkdwn text={message.text ?? ""} />
      )}
      {streaming && (
        <span className="inline-flex items-center gap-2 text-xs text-muted-foreground">
          <span aria-hidden className="inline-block h-3.5 w-1.5 animate-pulse rounded-sm bg-foreground/60" />
          <span className="sr-only">Still writing</span>
          {!message.pending && <StopStream message={message} />}
        </span>
      )}
    </>
  )
}
