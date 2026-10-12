import { createClient, type Fetch } from "@campflare/client"
import { createWorkspace, type Workspace } from "@campflare/core"
import { useMemo, useState } from "react"
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

export function App({ store, autoSession, connect = connectTo, fetch }: AppProps) {
  const [session, setSession] = useState<Session | null>(() => autoSession ?? store.load())
  const workspace = useMemo(() => (session ? connect(session) : null), [session, connect])

  return (
    <TooltipProvider>
      {workspace ? (
        <WorkspaceProvider workspace={workspace}>
          <Shell
            onSignOut={() => {
              store.clear()
              setSession(null)
            }}
          />
        </WorkspaceProvider>
      ) : (
        <LoginScreen
          fetch={fetch}
          onSignIn={(s) => {
            store.save(s)
            setSession(s)
          }}
        />
      )}
      <Toaster />
    </TooltipProvider>
  )
}
