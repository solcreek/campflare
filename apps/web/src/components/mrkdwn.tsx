import {
  type Block,
  conversationTitle,
  displayName,
  emojiLook,
  type Inline,
  parseMarkdown,
  parseMrkdwn,
} from "@campflare/core"
import { useMemo, useState } from "react"
import { cn } from "@/lib/utils"
import { useWorkspaceState } from "@/workspace"

// Renders mrkdwn and markdown as React elements, never as an HTML string.

function InlineNodes({ nodes }: { nodes: Inline[] }) {
  return nodes.map((node, i) => <InlineNode key={i} node={node} />)
}

function Mention({ children }: { children: string }) {
  return <span className="rounded bg-link/10 px-0.5 font-medium text-link">{children}</span>
}

function UserMention({ id, label }: { id: string; label?: string }) {
  const name = useWorkspaceState((s) => s.users[id])
  return <Mention>{`@${label ?? displayName(name)}`}</Mention>
}

function ChannelMention({ id, label }: { id: string; label?: string }) {
  const title = useWorkspaceState((s) => {
    const c = s.conversations[id]
    return c ? conversationTitle(s, c) : undefined
  })
  return <Mention>{`#${label ?? title ?? id}`}</Mention>
}

/**
 * An emoji by shortcode: a standard one's character, the workspace's own as its image (in
 * messages and reactions alike), else the :name: people typed, which also stands in for an
 * image that fails to load.
 */
export function Emoji({ name }: { name: string }) {
  const custom = useWorkspaceState((s) => s.emoji)
  const look = emojiLook(custom, name)
  const [broken, setBroken] = useState<string>()
  if (look && "char" in look) {
    return (
      <span role="img" aria-label={name} title={`:${name}:`}>
        {look.char}
      </span>
    )
  }
  if (look && look.url !== broken) {
    return (
      <img
        src={look.url}
        alt={name}
        title={`:${name}:`}
        loading="lazy"
        onError={() => setBroken(look.url)}
        className="inline-block size-[1.375em] object-contain align-text-bottom"
      />
    )
  }
  return <span>{`:${name}:`}</span>
}

function InlineNode({ node }: { node: Inline }) {
  switch (node.type) {
    case "text":
      return node.text
    case "bold":
      return (
        <strong>
          <InlineNodes nodes={node.children} />
        </strong>
      )
    case "italic":
      return (
        <em>
          <InlineNodes nodes={node.children} />
        </em>
      )
    case "strike":
      return (
        <s>
          <InlineNodes nodes={node.children} />
        </s>
      )
    case "code":
      return <code className="rounded bg-muted px-1 py-0.5 font-mono text-[0.85em]">{node.text}</code>
    case "link":
      // Message text is anyone's: only web and mail links become links.
      if (!/^(https?|mailto):/i.test(node.url)) return node.label ?? node.url
      return (
        <a href={node.url} target="_blank" rel="noreferrer" className="text-link underline underline-offset-2">
          {node.label ?? node.url}
        </a>
      )
    case "user":
      return <UserMention id={node.id} label={node.label} />
    case "channel":
      return <ChannelMention id={node.id} label={node.label} />
    case "usergroup":
      // The handle rides in the mention (<!subteam^S123|@handle>); the app doesn't load groups yet.
      return <Mention>{`@${node.label ?? node.id}`}</Mention>
    case "broadcast":
      return <Mention>{`@${node.name}`}</Mention>
    case "emoji":
      return <Emoji name={node.name} />
  }
}

const HEADINGS = ["h1", "h2", "h3", "h4", "h5", "h6"] as const
const HEADING_SIZES = ["text-xl", "text-lg", "text-base", "text-base", "text-sm", "text-sm"]

function BlockNode({ block }: { block: Block }) {
  switch (block.type) {
    case "pre":
      return (
        <pre className="overflow-x-auto rounded-md border bg-muted p-2 font-mono text-xs whitespace-pre">
          {block.text}
        </pre>
      )
    case "quote":
      return (
        <blockquote className="border-l-4 pl-3 text-muted-foreground">
          <InlineNodes nodes={block.children} />
        </blockquote>
      )
    case "heading": {
      const Heading = HEADINGS[block.level - 1]!
      return (
        <Heading className={cn("font-semibold", HEADING_SIZES[block.level - 1])}>
          <InlineNodes nodes={block.children} />
        </Heading>
      )
    }
    case "list": {
      const List = block.ordered ? "ol" : "ul"
      return (
        <List
          start={block.ordered && block.start !== 1 ? block.start : undefined}
          className={cn("space-y-0.5 pl-6", block.ordered ? "list-decimal" : "list-disc")}
        >
          {block.items.map((item, i) => (
            <li key={i}>
              <InlineNodes nodes={item} />
            </li>
          ))}
        </List>
      )
    }
    case "rule":
      return <hr className="my-2" />
    case "paragraph":
      return (
        <p>
          <InlineNodes nodes={block.children} />
        </p>
      )
  }
}

function Blocks({ blocks }: { blocks: Block[] }) {
  return (
    <div className="space-y-1 break-words whitespace-pre-wrap">
      {blocks.map((block, i) => (
        <BlockNode key={i} block={block} />
      ))}
    </div>
  )
}

/** Slack's mrkdwn: message text. */
export function Mrkdwn({ text }: { text: string }) {
  const blocks = useMemo(() => parseMrkdwn(text), [text])
  return <Blocks blocks={blocks} />
}

/** Markdown: what apps stream as markdown_text, and markdown blocks. */
export function Markdown({ text }: { text: string }) {
  const blocks = useMemo(() => parseMarkdown(text), [text])
  return <Blocks blocks={blocks} />
}
