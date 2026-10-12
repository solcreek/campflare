import { createClient, type Fetch } from "@campflare/client"
import { createWorkspace, type Workspace } from "@campflare/core"
import { useEffect, useMemo, useState } from "react"
import { toast } from "sonner"
import { Toaster } from "@/components/ui/sonner"
import { TooltipProvider } from "@/components/ui/tooltip"
import { LoginScreen } from "./components/login-screen"
import { Shell } from "./components/shell"
import type { Session, SessionStore } from "./session"
import { WorkspaceProvider } from "./workspace"

export interface AppProps {
  store: SessionStore
  /** Signs in by itself (the dev server's people); used instead of the stored session. */
  autoSession?: Session | null
  /** How a session becomes a live workspace; tests pass one on a fake server. */
  connect?: (session: Session) => Workspace
  /** The fetch the sign-in check uses; tests pass a fake server's. */
  fetch?: Fetch
}

const connectTo = (session: Session) => createWorkspace({ client: createClient(session) })

/** A store that failed to save or clear: the app goes on, but says so. */
const reportStoreError = (what: string) => (error: unknown) =>
  toast.error(`Couldn't ${what} the sign-in: ${error instanceof Error ? error.message : String(error)}`)

export function App({ store, autoSession, connect = connectTo, fetch }: AppProps) {
  // undefined while the store loads; a store that can't be read means signed out.
  const [session, setSession] = useState<Session | null | undefined>(autoSession ?? undefined)
  useEffect(() => {
    if (autoSession) return
    let live = true
    store
      .load()
      .catch(() => null)
      .then((loaded) => {
        if (live) setSession(loaded)
      })
    return () => {
      live = false
    }
  }, [store, autoSession])
  const workspace = useMemo(() => (session ? connect(session) : null), [session, connect])

  return (
    <TooltipProvider>
      {session === undefined ? (
        <main className="flex min-h-svh items-center justify-center text-muted-foreground" aria-busy="true">
          Loading…
        </main>
      ) : workspace ? (
        <WorkspaceProvider workspace={workspace}>
          <Shell
            onSignOut={() => {
              store.clear().catch(reportStoreError("forget"))
              setSession(null)
            }}
          />
        </WorkspaceProvider>
      ) : (
        <LoginScreen
          fetch={fetch}
          onSignIn={(s) => {
            store.save(s).catch(reportStoreError("keep"))
            setSession(s)
          }}
        />
      )}
      <Toaster />
    </TooltipProvider>
  )
}
