import { interactiveBlocks, type Click, type FeedbackButton, type Message } from "@campflare/core"
import { Loader2Icon } from "lucide-react"
import { useMemo, useState } from "react"
import { Button, buttonVariants } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { useWorkspace } from "@/workspace"

// An app's buttons in a message: `actions` blocks of buttons and
// `context_actions` blocks of feedback buttons. A click goes to the app
// (workspace.click); what it does about it, a replaced message or a reply only
// you see, comes back as events like any other.

const VARIANT = { primary: "default", danger: "destructive" } as const

/** The error code of a failed click, for the line under the buttons. */
function codeOf(error: unknown): string {
  return error && typeof error === "object" && "code" in error ? String(error.code) : String(error)
}

export function MessageBlocks({ message }: { message: Message }) {
  const workspace = useWorkspace()
  const blocks = useMemo(() => interactiveBlocks(message.blocks), [message.blocks])
  /** The button whose click is on its way, as `block/action/value`. */
  const [pending, setPending] = useState<string>()
  const [error, setError] = useState<string>()
  /** The feedback given, by block and action: which value. */
  const [given, setGiven] = useState<Record<string, string>>({})
  if (blocks.length === 0) return null
  // A message still sending, or one only you see, isn't stored: there's no message for the app to hear about.
  const inert = Boolean(message.pending || message.is_ephemeral)

  const click = async (c: Click) => {
    const key = `${c.blockId}/${c.actionId}/${c.value ?? ""}`
    setPending(key)
    setError(undefined)
    try {
      await workspace.click(message.channel, message.ts, c)
      return true
    } catch (e) {
      setError(codeOf(e))
      return false
    } finally {
      setPending((p) => (p === key ? undefined : p))
    }
  }
  const busy = (c: Click) => pending === `${c.blockId}/${c.actionId}/${c.value ?? ""}`

  return (
    <div className="mt-1 space-y-1">
      {blocks.map((block) => {
        if (block.type === "actions") {
          return (
            <div key={block.blockId} className="flex flex-wrap gap-1">
              {block.buttons.map((button) => {
                const c: Click = {
                  blockId: block.blockId,
                  actionId: button.actionId,
                  ...(button.value !== undefined ? { value: button.value } : {}),
                }
                const variant = button.style ? VARIANT[button.style] : "outline"
                const spinner = busy(c) && <Loader2Icon aria-hidden className="animate-spin" />
                // A link button opens its page and still tells the app, as Slack's do.
                if (button.url) {
                  return (
                    <a
                      key={button.actionId}
                      href={button.url}
                      target="_blank"
                      rel="noreferrer"
                      aria-label={button.accessibilityLabel}
                      aria-disabled={inert || undefined}
                      onClick={() => void (inert || click(c))}
                      className={cn(buttonVariants({ variant, size: "sm" }))}
                    >
                      {spinner}
                      {button.label}
                    </a>
                  )
                }
                return (
                  <Button
                    key={button.actionId}
                    size="sm"
                    variant={variant}
                    aria-label={button.accessibilityLabel}
                    aria-busy={busy(c) || undefined}
                    disabled={inert || pending !== undefined}
                    onClick={() => void click(c)}
                  >
                    {spinner}
                    {button.label}
                  </Button>
                )
              })}
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
