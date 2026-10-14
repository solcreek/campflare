import {
  conversationTitle,
  displayName,
  interactiveBlocks,
  type ActionElement,
  type Click,
  type FeedbackButton,
  type MenuOption,
  type Message,
  type SelectMenu,
} from "@campflare/core"
import { EllipsisIcon, Loader2Icon, Trash2Icon } from "lucide-react"
import { useMemo, useState, type ReactNode } from "react"
import { Button, buttonVariants } from "@/components/ui/button"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { cn } from "@/lib/utils"
import { useWorkspace, useWorkspaceState } from "@/workspace"

// An app's interactive elements in a message (or a view): `actions` blocks of
// buttons, icon buttons, select menus and overflow menus, a section's
// accessory, and `context_actions` blocks of feedback buttons. A click goes to
// the app (workspace.click); what it does about it, a replaced message, a
// reply only you see, a modal, comes back as events like any other.

const VARIANT = { primary: "default", danger: "destructive" } as const

/** Icons Slack's icon_button names. */
const ICONS: Record<string, ReactNode> = { trash: <Trash2Icon aria-hidden /> }

const keyOf = (c: Click) => `${c.blockId}/${c.actionId}/${c.value ?? ""}`

const item = (o: MenuOption) => (
  <option key={o.value} value={o.value}>
    {o.label}
  </option>
)

/** The error code of a failed click, for the line under the buttons. */
function codeOf(error: unknown): string {
  return error && typeof error === "object" && "code" in error ? String(error.code) : String(error)
}

export const selectClass =
  "h-8 rounded-lg border border-input bg-transparent px-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-50 aria-invalid:border-destructive dark:bg-input/30"

/** What a select menu offers: the app's options, or the people, conversations or public channels you know. */
export function useMenuOptions(select: SelectMenu["select"], options: MenuOption[]): MenuOption[] {
  const users = useWorkspaceState((s) => s.users)
  const conversations = useWorkspaceState((s) => s.conversations)
  const self = useWorkspaceState((s) => s.self)
  return useMemo(() => {
    if (select === "static") return options
    if (select === "users") {
      return Object.values(users)
        .filter((u) => !u.deleted)
        .map((u) => ({ label: displayName(u), value: u.id }))
        .toSorted((a, b) => a.label.localeCompare(b.label))
    }
    return Object.values(conversations)
      .filter(
        (c) => !c.is_archived && (select === "conversations" ? c.is_member || c.is_im : c.is_channel && !c.is_private),
      )
      .map((c) => ({
        label: c.is_im || c.is_mpim ? conversationTitle({ users, self }, c) : `#${c.name}`,
        value: c.id,
      }))
      .toSorted((a, b) => a.label.localeCompare(b.label))
  }, [select, options, users, conversations, self])
}

/** A native select of a menu's options, grouped as the app grouped them. */
export function MenuSelect({
  menu,
  value,
  onChange,
  disabled,
  label,
  invalid,
  describedBy,
  id,
}: {
  menu: Pick<SelectMenu, "select" | "options" | "placeholder">
  value: string | undefined
  onChange: (value: string) => void
  disabled?: boolean
  label?: string
  invalid?: boolean
  describedBy?: string
  id?: string
}) {
  const options = useMenuOptions(menu.select, menu.options)
  const groups = [...new Set(options.map((o) => o.group))]
  return (
    <select
      id={id}
      aria-label={label}
      aria-invalid={invalid || undefined}
      aria-describedby={describedBy}
      className={selectClass}
      value={value ?? ""}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value)}
    >
      <option value="" disabled>
        {menu.placeholder ?? "Choose…"}
      </option>
      {groups.map((group) =>
        group === undefined ? (
          options.filter((o) => o.group === undefined).map(item)
        ) : (
          <optgroup key={group} label={group}>
            {options.filter((o) => o.group === group).map(item)}
          </optgroup>
        ),
      )}
    </select>
  )
}

/** The interactive blocks of `blocks`, each click handed to `onClick`, which resolves once the app took it. */
export function BlockActions({
  blocks,
  onClick,
  inert = false,
}: {
  blocks: unknown
  onClick: (click: Click) => Promise<void>
  inert?: boolean
}) {
  const found = useMemo(() => interactiveBlocks(blocks), [blocks])
  /** The element whose click is on its way, as `block/action/value`. */
  const [pending, setPending] = useState<string>()
  const [error, setError] = useState<string>()
  /** The feedback given, by block and action: which value. */
  const [given, setGiven] = useState<Record<string, string>>({})
  /** What each select menu shows, by block and action, once chosen here. */
  const [chosen, setChosen] = useState<Record<string, string>>({})
  if (found.length === 0) return null

  const click = async (c: Click) => {
    const key = keyOf(c)
    setPending(key)
    setError(undefined)
    try {
      await onClick(c)
      return true
    } catch (e) {
      setError(codeOf(e))
      return false
    } finally {
      setPending((p) => (p === key ? undefined : p))
    }
  }
  const busy = (c: Click) => pending === keyOf(c)
  const spinner = (c: Click) => busy(c) && <Loader2Icon aria-hidden className="animate-spin" />

  const element = (blockId: string, e: ActionElement) => {
    const base = { blockId, actionId: e.actionId }
    if (e.kind === "select") {
      const key = `${blockId}/${e.actionId}`
      return (
        <MenuSelect
          key={e.actionId}
          menu={e}
          label={e.placeholder ?? "Choose"}
          value={chosen[key] ?? e.initial}
          disabled={inert || pending !== undefined}
          onChange={(value) => {
            const before = chosen[key]
            setChosen((c) => ({ ...c, [key]: value }))
            void click({ ...base, value }).then((ok) => {
              if (!ok) setChosen((c) => ({ ...c, [key]: before ?? "" }))
            })
          }}
        />
      )
    }
    if (e.kind === "overflow") {
      return (
        <DropdownMenu key={e.actionId}>
          <DropdownMenuTrigger
            disabled={inert || pending !== undefined}
            render={<Button size="icon-sm" variant="outline" aria-label="More actions" />}
          >
            <EllipsisIcon aria-hidden />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            {e.options.map((o) => (
              <DropdownMenuItem key={o.value} onClick={() => void click({ ...base, value: o.value })}>
                {o.label}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      )
    }
    const c: Click = { ...base, ...(e.value !== undefined ? { value: e.value } : {}) }
    if (e.kind === "icon") {
      const icon = ICONS[e.icon]
      return (
        <Button
          key={e.actionId}
          size={icon ? "icon-sm" : "sm"}
          variant="ghost"
          title={e.label}
          aria-label={e.accessibilityLabel ?? e.label}
          aria-busy={busy(c) || undefined}
          disabled={inert || pending !== undefined}
          onClick={() => void click(c)}
        >
          {busy(c) ? <Loader2Icon aria-hidden className="animate-spin" /> : (icon ?? e.label)}
        </Button>
      )
    }
    const variant = e.style ? VARIANT[e.style] : "outline"
    // A link button opens its page and still tells the app, as Slack's do.
    if (e.url) {
      return (
        <a
          key={e.actionId}
          href={e.url}
          target="_blank"
          rel="noreferrer"
          aria-label={e.accessibilityLabel}
          aria-disabled={inert || undefined}
          onClick={() => void (inert || click(c))}
          className={cn(buttonVariants({ variant, size: "sm" }))}
        >
          {spinner(c)}
          {e.label}
        </a>
      )
    }
    return (
      <Button
        key={e.actionId}
        size="sm"
        variant={variant}
        aria-label={e.accessibilityLabel}
        aria-busy={busy(c) || undefined}
        disabled={inert || pending !== undefined}
        onClick={() => void click(c)}
      >
        {spinner(c)}
        {e.label}
      </Button>
    )
  }

  return (
    <div className="mt-1 space-y-1">
      {found.map((block) => {
        if (block.type === "actions") {
          return (
            <div key={block.blockId} className="flex flex-wrap items-center gap-1">
              {block.elements.map((e) => element(block.blockId, e))}
            </div>
          )
        }
        const key = `${block.blockId}/${block.actionId}`
        const feedback = (button: FeedbackButton, emoji: string) => {
          const c: Click = { blockId: block.blockId, actionId: block.actionId, value: button.value }
          return (
            <Button
              key={button.value}
              size="icon-sm"
              variant="ghost"
              title={button.label}
              aria-label={button.accessibilityLabel ?? button.label}
              aria-pressed={given[key] === button.value}
              aria-busy={busy(c) || undefined}
              disabled={inert || pending !== undefined}
              onClick={() =>
                void click(c).then((ok) => {
                  if (ok) setGiven((g) => ({ ...g, [key]: button.value }))
                })
              }
            >
              {busy(c) ? <Loader2Icon aria-hidden className="animate-spin" /> : <span aria-hidden>{emoji}</span>}
            </Button>
          )
        }
        return (
          <div key={block.blockId} className="flex gap-1">
            {feedback(block.positive, "👍")}
            {feedback(block.negative, "👎")}
          </div>
        )
      })}
      {error && (
        <div role="alert" className="text-sm text-destructive">
          The app didn't take that ({error}).
        </div>
      )}
    </div>
  )
}

export function MessageBlocks({ message }: { message: Message }) {
  const workspace = useWorkspace()
  // A message still sending isn't stored: there's no message for the app to hear about.
  // An ephemeral one is: the server keeps an app's for a day.
  return (
    <BlockActions
      blocks={message.blocks}
      inert={Boolean(message.pending)}
      onClick={(c) => workspace.click(message.channel, message.ts, c)}
    />
  )
}
