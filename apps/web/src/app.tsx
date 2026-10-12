import { createClient, type Fetch } from "@campflare/client"
import { createWorkspace, type Workspace } from "@campflare/core"
import { useCallback, useEffect, useMemo, useState } from "react"
import { toast } from "sonner"
import { Toaster } from "@/components/ui/sonner"
import { TooltipProvider } from "@/components/ui/tooltip"
import { LoginScreen } from "./components/login-screen"
import { Shell } from "./components/shell"
import { lastServer, rememberServer } from "./server-address"
import type { Session, SessionStore } from "./session"
import { type BrowserSignIn, platformSignIn } from "./sign-in"
import { WorkspaceProvider } from "./workspace"

export interface AppProps {
  store: SessionStore
  /** Signs in by itself (the dev server's people); used instead of the stored session. */
  autoSession?: Session | null
  /** How a session becomes a live workspace; tests pass one on a fake server. */
  connect?: (session: Session) => Workspace
  /** The fetch the sign-in check uses; tests pass a fake server's. */
  fetch?: Fetch
  /** Sign-in through the browser; the platform's own (a redirect on the web, loopback on the desktop) by default. */
  signIn?: BrowserSignIn
  /** The dev server's address: the login screen starts with it. */
  devServer?: string
  /** The page's own origin on the web: the login screen offers it when it answers api.test. */
  origin?: string
}

const connectTo = (session: Session) => createWorkspace({ client: createClient(session) })

/** A store that failed to save or clear: the app goes on, but says so. */
const reportStoreError = (what: string) => (error: unknown) =>
  toast.error(`Couldn't ${what} the sign-in: ${error instanceof Error ? error.message : String(error)}`)

export function App({ store, autoSession, connect = connectTo, fetch, signIn: given, devServer, origin }: AppProps) {
  const [own] = useState(() => given ?? platformSignIn(globalThis as never, fetch))
  const signIn = given ?? own
  // The browser coming back from a sign-in wins over a kept session: the person just chose whom to sign in as.
  const [returning] = useState(() => !autoSession && signIn.returning())
  // undefined while the store loads; a store that can't be read means signed out.
  const [session, setSession] = useState<Session | null | undefined>(autoSession ?? (returning ? null : undefined))
  useEffect(() => {
    if (autoSession || returning) return
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
  }, [store, autoSession, returning])
  const onSignIn = useCallback(
    (s: Session) => {
      store.save(s).catch(reportStoreError("keep"))
      // Outlives the session: signing out forgets the token, not where to sign in again.
      rememberServer(s.url)
      setSession(s)
    },
    [store],
  )
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
          signIn={signIn}
          onSignIn={onSignIn}
          server={devServer || lastServer()}
          probeOrigin={origin}
        />
      )}
      <Toaster />
    </TooltipProvider>
  )
}
