import { useEffect } from "react"
import { Button } from "@/components/ui/button"
import { useRoute } from "@/route"
import { useWorkspace, useWorkspaceState } from "@/workspace"
import { ConversationView, ThreadPanel } from "./conversation"
import { Sidebar } from "./sidebar"

/** The signed-in app: sidebar, the open conversation, and its open thread. */
export function Shell({ onSignOut }: { onSignOut: () => void }) {
  const workspace = useWorkspace()
  const status = useWorkspaceState((s) => s.status)
  const error = useWorkspaceState((s) => s.error)
  const fallback = useWorkspaceState((s) => {
    const mine = Object.values(s.conversations).filter((c) => c.is_member && !c.is_archived)
    return (mine.find((c) => c.is_general) ?? mine[0])?.id
  })
  const [route, navigate] = useRoute()
  const known = useWorkspaceState((s) => Boolean(route.channel && s.conversations[route.channel]))
  // A link to a reply (#/C/<thread>?msg=<reply>) highlights it in the thread, and the thread's head in the conversation.
  const linked = route.message && route.thread ? route.thread : route.message

  useEffect(() => {
    void workspace.start()
    return () => workspace.stop()
  }, [workspace])

  // With no conversation in the URL, open #general (or the first one you're in).
  useEffect(() => {
    if (status === "ready" && !route.channel && fallback) navigate({ channel: fallback })
  }, [status, route.channel, fallback, navigate])

  if (status === "error")
    return (
      <main className="flex min-h-svh flex-col items-center justify-center gap-3 p-6">
        <p role="alert">Couldn't load the workspace: {error}</p>
        <div className="flex gap-2">
          <Button onClick={() => void workspace.start()}>Try again</Button>
          <Button variant="outline" onClick={onSignOut}>
            Sign out
          </Button>
        </div>
      </main>
    )
  if (status !== "ready")
    return (
      <main className="flex min-h-svh items-center justify-center text-muted-foreground" aria-busy="true">
        Loading…
      </main>
    )

  return (
    <div className="flex h-svh">
      <Sidebar active={route.channel} onSelect={(channel) => navigate({ channel })} onSignOut={onSignOut} />
      {route.channel ? (
        <ConversationView
          key={route.channel}
          channel={route.channel}
          onOpenThread={(thread) => navigate({ channel: route.channel, thread })}
          highlight={linked}
          onClearHighlight={() => navigate({ channel: route.channel, thread: route.thread })}
          onLeave={() => navigate({})}
        />
      ) : (
        <p className="flex-1 p-6 text-muted-foreground">Pick a conversation.</p>
      )}
      {route.channel && route.thread && known && (
        <ThreadPanel
          key={`${route.channel}/${route.thread}`}
          channel={route.channel}
          threadTs={route.thread}
          onClose={() => navigate({ channel: route.channel })}
          highlight={route.message}
          onClearHighlight={() => navigate({ channel: route.channel, thread: route.thread })}
        />
      )}
    </div>
  )
}
