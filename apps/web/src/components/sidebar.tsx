import { browsableChannels, type Conversation, conversationTitle, sidebar } from "@campflare/core"
import { HashIcon, LockIcon, LogOutIcon, PlusIcon, UsersIcon } from "lucide-react"
import { type FormEvent, type ReactNode, useMemo, useState } from "react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Input } from "@/components/ui/input"
import { cn } from "@/lib/utils"
import { useWorkspace, useWorkspaceState } from "@/workspace"
import { reportError } from "./message"

const CONNECTION_LABEL = {
  offline: "Offline",
  connecting: "Connecting…",
  connected: "Connected",
  disconnected: "Reconnecting…",
} as const

function Item({
  conversation,
  active,
  onSelect,
}: {
  conversation: Conversation
  active: boolean
  onSelect: (id: string) => void
}) {
  const title = useWorkspaceState((s) => conversationTitle(s, conversation))
  const unread = useWorkspaceState((s) => s.unread[conversation.id] ?? 0)
  const icon = conversation.is_im ? null : conversation.is_mpim ? (
    <UsersIcon className="size-4 shrink-0" />
  ) : conversation.is_private ? (
    <LockIcon className="size-4 shrink-0" />
  ) : (
    <HashIcon className="size-4 shrink-0" />
  )
  return (
    <li>
      <button
        type="button"
        aria-current={active ? "page" : undefined}
        onClick={() => onSelect(conversation.id)}
        className={cn(
          "flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-sm hover:bg-sidebar-accent",
          active && "bg-sidebar-accent font-medium",
          unread > 0 && "font-semibold",
        )}
      >
        {icon ?? <span className="size-4 shrink-0 rounded-full bg-muted-foreground/40" />}
        <span className="truncate">{title}</span>
        {unread > 0 && (
          <Badge className="ml-auto" aria-label={`${unread} unread`}>
            {unread}
          </Badge>
        )}
      </button>
    </li>
  )
}

function Section({ title, action, children }: { title: string; action?: ReactNode; children: ReactNode }) {
  return (
    <nav aria-label={title} className="space-y-1">
      <div className="flex items-center justify-between px-2 text-xs font-medium text-muted-foreground">
        <h2>{title}</h2>
        {action}
      </div>
      <ul className="space-y-0.5">{children}</ul>
    </nav>
  )
}

function ChannelDialog({
  open,
  onOpenChange,
  onSelect,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onSelect: (id: string) => void
}) {
  const workspace = useWorkspace()
  const conversations = useWorkspaceState((s) => s.conversations)
  const joinable = useMemo(() => browsableChannels({ conversations }), [conversations])
  const [name, setName] = useState("")

  const create = (e: FormEvent) => {
    e.preventDefault()
    const clean = name.trim().toLowerCase().replaceAll(/\s+/g, "-")
    if (!clean) return
    workspace
      .createChannel(clean)
      .then((id) => {
        setName("")
        onOpenChange(false)
        onSelect(id)
      })
      .catch(reportError("create the channel"))
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Channels</DialogTitle>
          <DialogDescription>Create a channel, or open one you haven't joined.</DialogDescription>
        </DialogHeader>
        <form onSubmit={create} className="flex gap-2">
          <Input
            aria-label="New channel name"
            placeholder="new-channel"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <Button type="submit" disabled={!name.trim()}>
            Create
          </Button>
        </form>
        {joinable.length > 0 && (
          <ul aria-label="Channels you can join" className="max-h-64 space-y-0.5 overflow-y-auto">
            {joinable.map((c) => (
              <li key={c.id}>
                <button
                  type="button"
                  className="flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-sm hover:bg-muted"
                  onClick={() => {
                    onOpenChange(false)
                    onSelect(c.id)
                  }}
                >
                  <HashIcon className="size-4" />
                  {c.name}
                </button>
              </li>
            ))}
          </ul>
        )}
        <DialogFooter showCloseButton />
      </DialogContent>
    </Dialog>
  )
}

export function Sidebar({
  active,
  onSelect,
  onSignOut,
}: {
  active?: string
  onSelect: (id: string) => void
  onSignOut: () => void
}) {
  const conversations = useWorkspaceState((s) => s.conversations)
  const users = useWorkspaceState((s) => s.users)
  const self = useWorkspaceState((s) => s.self)
  const lists = useMemo(() => sidebar({ conversations, users, self }), [conversations, users, self])
  const me = useWorkspaceState((s) => (s.self ? s.users[s.self.userId] : undefined))
  const connection = useWorkspaceState((s) => s.connection)
  const [browsing, setBrowsing] = useState(false)

  return (
    <div className="flex w-64 shrink-0 flex-col border-r bg-sidebar text-sidebar-foreground">
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <button
              type="button"
              aria-label={`${self?.teamName ?? "Workspace"} menu`}
              className="flex h-12 items-center gap-2 border-b px-4 text-left hover:bg-sidebar-accent"
            />
          }
        >
          <span className="truncate font-semibold">{self?.teamName}</span>
          <span
            role="status"
            aria-label={CONNECTION_LABEL[connection]}
            title={CONNECTION_LABEL[connection]}
            className={cn(
              "ml-auto size-2 shrink-0 rounded-full",
              connection === "connected" ? "bg-green-500" : "bg-amber-500",
            )}
          />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-56">
          {/* Base UI wants menu labels inside a group. */}
          <DropdownMenuGroup>
            <DropdownMenuLabel>{me ? `Signed in as ${me.name}` : "Signed in"}</DropdownMenuLabel>
            <DropdownMenuLabel className="font-normal text-muted-foreground">{self?.url}</DropdownMenuLabel>
          </DropdownMenuGroup>
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={onSignOut}>
            <LogOutIcon />
            Sign out
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <div className="flex-1 space-y-4 overflow-y-auto p-2">
        <Section
          title="Channels"
          action={
            <Button variant="ghost" size="icon-xs" aria-label="Add channels" onClick={() => setBrowsing(true)}>
              <PlusIcon />
            </Button>
          }
        >
          {lists.channels.map((c) => (
            <Item key={c.id} conversation={c} active={c.id === active} onSelect={onSelect} />
          ))}
        </Section>
        <Section title="Direct messages">
          {lists.directMessages.map((c) => (
            <Item key={c.id} conversation={c} active={c.id === active} onSelect={onSelect} />
          ))}
        </Section>
      </div>
      <ChannelDialog open={browsing} onOpenChange={setBrowsing} onSelect={onSelect} />
    </div>
  )
}
