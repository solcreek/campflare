import { conversationTitle, displayName, emojiChar, type Inline, parseMrkdwn } from "@campflare/core"
import { useMemo } from "react"
import { useWorkspaceState } from "@/workspace"

// Renders mrkdwn as React elements, never as an HTML string.

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

/** An emoji by shortcode: the character when known, else the :name: people typed. */
export function Emoji({ name }: { name: string }) {
  const char = emojiChar(name)
  return char ? (
    <span role="img" aria-label={name} title={`:${name}:`}>
      {char}
    </span>
  ) : (
    <span>{`:${name}:`}</span>
  )
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
    case "broadcast":
      return <Mention>{`@${node.name}`}</Mention>
    case "emoji":
      return <Emoji name={node.name} />
  }
}

export function Mrkdwn({ text }: { text: string }) {
  const blocks = useMemo(() => parseMrkdwn(text), [text])
  return (
    <div className="space-y-1 break-words whitespace-pre-wrap">
      {blocks.map((block, i) => {
        if (block.type === "pre")
          return (
            <pre key={i} className="overflow-x-auto rounded-md border bg-muted p-2 font-mono text-xs">
              {block.text}
            </pre>
          )
        if (block.type === "quote")
          return (
            <blockquote key={i} className="border-l-4 pl-3 text-muted-foreground">
              <InlineNodes nodes={block.children} />
            </blockquote>
          )
        return (
          <p key={i}>
            <InlineNodes nodes={block.children} />
          </p>
        )
      })}
    </div>
  )
}
