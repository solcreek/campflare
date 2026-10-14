import type { Message, MessageBlock } from "@campflare/core"
import { Markdown, Mrkdwn } from "./mrkdwn"

// What a message says. Text is mrkdwn; a message with markdown blocks (what an
// app streams with chat.startStream, or posts as a markdown block) shows its
// blocks instead, in order: markdown, and the text of sections, headers and
// context. Blocks that act (buttons, feedback buttons) are MessageBlocks's.

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
    default:
      return null
  }
}

/** Whether a message reads from its blocks rather than its text. */
export const showsBlocks = (m: Pick<Message, "blocks">) => Boolean(m.blocks?.some((b) => b.type === "markdown"))

export function MessageBody({ message }: { message: Message }) {
  const streaming = message.streaming_state === "in_progress"
  return (
    <>
      {showsBlocks(message) ? (
        <div className="space-y-1">
          {message.blocks!.map((block, i) => (
            <BlockView key={i} block={block} />
          ))}
        </div>
      ) : (
        <Mrkdwn text={message.text ?? ""} />
      )}
      {streaming && (
        <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
          <span aria-hidden className="inline-block h-3.5 w-1.5 animate-pulse rounded-sm bg-foreground/60" />
          <span className="sr-only">Still writing</span>
        </span>
      )}
    </>
  )
}
