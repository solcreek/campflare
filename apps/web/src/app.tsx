import { createClient, type Fetch } from "@campflare/client"
import { createWorkspace, type Workspace } from "@campflare/core"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { toast } from "sonner"
import { Toaster } from "@/components/ui/sonner"
import { TooltipProvider } from "@/components/ui/tooltip"
import { LoginScreen } from "./components/login-screen"
import { OtherServerLink } from "./components/other-server-link"
import { Shell } from "./components/shell"
import { type DeepLink, deepLinkHash, type DeepLinks, parseDeepLink, platformDeepLinks, serverOf } from "./deep-link"
import { lastServer, rememberServer } from "./server-address"
import { revokeSession, type Session, type SessionStore } from "./session"
import { type BrowserSignIn, platformSignIn } from "./sign-in"
import { WorkspaceProvider } from "./workspace"

export interface AppProps {
  store: SessionStore
  /** Signs in by itself (the dev server's people); used instead of the stored session. */
  autoSession?: Session | null
  /** How a session becomes a live workspace; tests pass one on a fake server. */
  connect?: (session: Session) => Workspace
  /** The fetch the sign-in check and sign-out's revoke use; tests pass a fake server's. */
  fetch?: Fetch
  /** Sign-in through the browser; the platform's own (a redirect on the web, loopback on the desktop) by default. */
  signIn?: BrowserSignIn
  /** The dev server's address: the login screen starts with it. */
  devServer?: string
  /** The page's own origin on the web: the login screen offers it when it answers api.test. */
  origin?: string
  /** campflare:// links handed over by the desktop shell; the shell's own by default, none in a browser. */
  deepLinks?: DeepLinks | null
}

const connectTo = (session: Session) => createWorkspace({ client: createClient(session) })

/** A store that failed to save or clear: the app goes on, but says so. */
const reportStoreError = (what: string) => (error: unknown) =>
  toast.error(`Couldn't ${what} the sign-in: ${error instanceof Error ? error.message : String(error)}`)

export function App({
  store,
  autoSession,
  connect = connectTo,
  fetch,
  signIn: given,
  devServer,
  origin,
  deepLinks: givenLinks,
}: AppProps) {
  const [own] = useState(() => given ?? platformSignIn(globalThis as never, fetch))
  const signIn = given ?? own
  // The browser coming back from a sign-in wins over a kept session: the person just chose whom to sign in as.
  const [returning] = useState(() => !autoSession && signIn.returning())
  // undefined while the store loads; a store that can't be read means signed out.
  const [session, setSession] = useState<Session | null | undefined>(autoSession ?? (returning ? null : undefined))

  // A campflare:// link (deep-link.ts) waits until the app is signed in, then opens
  // if it's on this server; on another, the app says so instead of not finding it.
  const [links] = useState(() => (givenLinks === undefined ? platformDeepLinks() : givenLinks))
  const [elsewhere, setElsewhere] = useState<DeepLink | null>(null)
  const linksSession = useRef(session)
  const waitingLink = useRef<DeepLink | null>(null)
  const openLink = useCallback((link: DeepLink | null, s: Session | null | undefined) => {
    if (!link) return
    waitingLink.current = s ? null : link
    if (!s) return
    if (serverOf(s.url) === link.server) window.location.hash = deepLinkHash(link)
    else setElsewhere(link)
  }, [])
  /** The session links open against, changed: a waiting link opens now if it can. */
  const sessionChanged = useCallback(
    (s: Session | null) => {
      linksSession.current = s
      openLink(waitingLink.current, s)
    },
    [openLink],
  )
  useEffect(() => {
    if (!links) return
    let live = true
    const receive = (urls: string[]) => {
      if (!live || urls.length === 0) return
      const link = urls.map(parseDeepLink).findLast((l) => l !== null)
      if (link) openLink(link, linksSession.current)
      else toast.error(`Campflare can't open ${urls.at(-1)}`)
    }
    links.current().then(receive, () => {})
    const stop = links.listen(receive)
    return () => {
      live = false
      stop.then(
        (unlisten) => unlisten(),
        () => {},
      )
    }
  }, [links, openLink])

  useEffect(() => {
    if (autoSession || returning) return
    let live = true
    store
      .load()
      .catch(() => null)
      .then((loaded) => {
        if (!live) return
        setSession(loaded)
        sessionChanged(loaded)
      })
    return () => {
      live = false
    }
  }, [store, autoSession, returning, sessionChanged])
  const onSignIn = useCallback(
    (s: Session) => {
      store.save(s).catch(reportStoreError("keep"))
      // Outlives the session: signing out forgets the token, not where to sign in again.
      rememberServer(s.url)
      setSession(s)
      sessionChanged(s)
    },
    [store, sessionChanged],
  )
  // Signing out ends the session on the server first (an OAuth token is revoked; see revokeSession),
  // then forgets it here, whether or not the server answered.
  const [signingOut, setSigningOut] = useState(false)
  const onSignOut = useCallback(async () => {
    if (!session) return
    setSigningOut(true)
    await revokeSession(session, { fetch })
    await store.clear().catch(reportStoreError("forget"))
    setSigningOut(false)
    setSession(null)
    sessionChanged(null)
  }, [session, store, fetch, sessionChanged])
  const workspace = useMemo(() => (session ? connect(session) : null), [session, connect])

  return (
    <TooltipProvider>
      {session === undefined || signingOut ? (
        <main className="flex min-h-svh items-center justify-center text-muted-foreground" aria-busy="true">
          {signingOut ? "Signing out…" : "Loading…"}
        </main>
      ) : workspace ? (
        <WorkspaceProvider workspace={workspace}>
          <Shell onSignOut={() => void onSignOut()} />
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
      <OtherServerLink
        link={elsewhere}
        signedIn={session ? serverOf(session.url) : ""}
        onClose={() => setElsewhere(null)}
      />
      {/* At the top: the composer and its Send button live at the bottom. */}
      <Toaster position="top-center" />
    </TooltipProvider>
  )
}
