import { buttonVariants } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import type { DeepLink } from "@/deep-link"

/**
 * A campflare:// link to a message on a server other than the one the app is
 * signed in to. The conversation can't be looked up from here, so instead of
 * a not-found view: which server it is, and the browser as a way to open it.
 */
export function OtherServerLink({
  link,
  signedIn,
  onClose,
}: {
  link: DeepLink | null
  signedIn: string
  onClose: () => void
}) {
  return (
    <Dialog open={Boolean(link)} onOpenChange={(open) => !open && onClose()}>
      <DialogContent showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>This link is to another server</DialogTitle>
          <DialogDescription>
            It points to a message on <strong className="text-foreground">{link?.server}</strong>, and Campflare is
            signed in to <strong className="text-foreground">{signedIn}</strong>. Open it in your browser, or sign out
            and sign in to {link?.server} to open it here.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter showCloseButton>
          {/* The desktop shell opens links to other origins in the system browser. */}
          <a className={buttonVariants()} href={link?.web} target="_blank" rel="noreferrer" onClick={onClose}>
            Open in your browser
          </a>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
