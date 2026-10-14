import { SearchXIcon, XIcon } from "lucide-react"
import type { ReactNode } from "react"
import { Button } from "@/components/ui/button"

/**
 * In place of a conversation a URL names that isn't there (an unknown or
 * private channel id, a link from another workspace): what happened, and a
 * way back.
 */
export function NotFoundView({ title, children, onBack }: { title: string; children: ReactNode; onBack: () => void }) {
  return (
    <section
      aria-label={title}
      className="flex min-w-0 flex-1 flex-col items-center justify-center gap-3 p-6 text-center"
    >
      <SearchXIcon className="size-8 text-muted-foreground" aria-hidden />
      <h1 className="text-lg font-semibold">{title}</h1>
      <p className="max-w-sm text-sm text-muted-foreground">{children}</p>
      <Button variant="outline" onClick={onBack}>
        Back to your conversations
      </Button>
    </section>
  )
}

/** Over a list whose linked message isn't in it: deleted, or a wrong link. */
export function MissingMessage({ children, onDismiss }: { children: ReactNode; onDismiss: () => void }) {
  return (
    <div role="status" className="flex items-center gap-2 border-b bg-muted/50 px-4 py-2 text-sm">
      <SearchXIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
      <p className="flex-1">{children}</p>
      <Button variant="ghost" size="icon-sm" aria-label="Dismiss" onClick={onDismiss}>
        <XIcon />
      </Button>
    </div>
  )
}
