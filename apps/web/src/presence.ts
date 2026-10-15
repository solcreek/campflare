import type { Workspace } from "@campflare/core"

// Whether the person is looking at the app, told to the server so it doesn't
// push to their phone meanwhile (docs/push.md): active while the window is
// visible and focused, said again every minute while that holds (the server
// forgets it after two), and inactive as soon as it doesn't.

export const ACTIVE_RESEND_MS = 60_000

export function reportActivity(
  workspace: Pick<Workspace, "setActive">,
  doc: Pick<Document, "visibilityState" | "hasFocus" | "addEventListener" | "removeEventListener"> = document,
  win: Pick<Window, "addEventListener" | "removeEventListener"> = window,
): () => void {
  let timer: ReturnType<typeof setInterval> | undefined
  let last: boolean | undefined
  const update = () => {
    const active = doc.visibilityState === "visible" && doc.hasFocus()
    if (active === last) return
    last = active
    workspace.setActive(active)
    clearInterval(timer)
    timer = active ? setInterval(() => workspace.setActive(true), ACTIVE_RESEND_MS) : undefined
  }
  win.addEventListener("focus", update)
  win.addEventListener("blur", update)
  doc.addEventListener("visibilitychange", update)
  update()
  return () => {
    clearInterval(timer)
    win.removeEventListener("focus", update)
    win.removeEventListener("blur", update)
    doc.removeEventListener("visibilitychange", update)
  }
}
