import {
  ApiError,
  authorizeUrl,
  callbackCode,
  createPkce,
  exchangeCode,
  type Fetch,
  OAuthError,
  randomState,
  serverRoot,
} from "@campflare/client"
import type { Invoke, Session } from "./session"

// Signing in through the browser: Slack's OAuth v2 with PKCE against the
// server's /oauth/v2/authorize, ending in a user token from oauth.v2.access.
// The protocol is @campflare/client's; what differs is how the browser comes
// back to the app:
//
// - Web: to the app's own URL, `<origin>/?code&state`, after a full page
//   navigation, so the verifier waits in sessionStorage under its state.
//   On loopback the app is `campflare-web` (a row on the server); anywhere
//   else its client_id is the URL of its Client ID Metadata Document,
//   `<origin>/oauth-client.json`, which the build emits (vite.config.ts).
// - Desktop: the webview can't be redirected to, so the shell listens on a
//   free loopback port (`oauth_listen`, `oauth_wait` in src-tauri/src/oauth.rs)
//   and the system browser comes back there, as the CLI's does.

/** The app does everything a person can, so it asks for the whole person: the `full` preset (docs/scopes-and-roles.md). */
export const USER_SCOPES = ["full"]

export interface BrowserSignIn {
  /**
   * Signs in to a server through the browser. On the web the page navigates
   * away (and `finish` picks it up on return), so it resolves null; on the
   * desktop it resolves with the session once the browser comes back.
   */
  start(server: string): Promise<Session | null>
  /** Whether this page is the browser coming back from a sign-in. */
  returning(): boolean
  /** The session from that return (or throws why not); the same promise however often it's asked. */
  finish(): Promise<Session>
  /** Stops waiting for the browser (desktop). */
  cancel(): void
}

/** The app as an OAuth client on the web: who it is, and where the browser comes back. */
export function webClient(origin: string): { clientId: string; redirectUri: string } {
  const { hostname } = new URL(origin)
  const loopback = hostname === "localhost" || hostname === "127.0.0.1"
  return { clientId: loopback ? "campflare-web" : `${origin}/oauth-client.json`, redirectUri: `${origin}/` }
}

const KEY = "campflare.oauth."

interface Pending {
  server: string
  verifier: string
  clientId: string
  redirectUri: string
  /** Where the person was when they signed in (a permalink's #/C123?msg=…): the redirect URI can't carry it. */
  hash?: string
}

export interface WebSignInOptions {
  location?: Pick<Location, "origin" | "search" | "pathname" | "hash">
  storage?: Pick<Storage, "getItem" | "setItem" | "removeItem">
  /** Leaves for the authorize page. */
  navigate?: (url: string) => void
  /** Puts a URL in the address bar without loading it (the callback's query, once read). */
  replaceUrl?: (url: string) => void
  fetch?: Fetch
}

export function webSignIn(opts: WebSignInOptions = {}): BrowserSignIn {
  const loc = opts.location ?? location
  const storage = opts.storage ?? sessionStorage
  const navigate = opts.navigate ?? ((url) => location.assign(url))
  const replaceUrl = opts.replaceUrl ?? ((url) => history.replaceState(history.state, "", url))
  let finishing: Promise<Session> | undefined

  const query = () => new URLSearchParams(loc.search)
  const returning = () => query().has("state") && (query().has("code") || query().has("error"))

  async function finish(): Promise<Session> {
    const q = query()
    const state = q.get("state") ?? ""
    const saved = storage.getItem(KEY + state)
    storage.removeItem(KEY + state)
    const pending = saved ? (JSON.parse(saved) as Pending) : undefined
    // The code is single-use and the query says nothing once read: out of the address bar and history.
    // Back where the sign-in started, so a link that asked for it lands on its message.
    replaceUrl(`${loc.pathname}${pending?.hash || loc.hash}`)
    if (!pending) throw new OAuthError("state_mismatch")
    const code = callbackCode(q, state)
    const res = await exchangeCode(pending.server, { ...pending, code, fetch: opts.fetch })
    return { url: pending.server, token: res.authed_user.access_token, via: "oauth" }
  }

  return {
    async start(server) {
      const { verifier, challenge } = await createPkce()
      const state = randomState()
      const { clientId, redirectUri } = webClient(loc.origin)
      const pending: Pending = { server: serverRoot(server), verifier, clientId, redirectUri, hash: loc.hash }
      storage.setItem(KEY + state, JSON.stringify(pending))
      navigate(authorizeUrl(server, { clientId, redirectUri, state, challenge, userScopes: USER_SCOPES }))
      return null
    },
    returning,
    // StrictMode runs effects twice; the second must not find the state already spent.
    finish: () => (finishing ??= finish()),
    cancel() {},
  }
}

/** What the shell's `oauth_wait` returns: the callback's query, or no answer (an error) on timeout or cancel. */
interface Callback {
  code?: string | null
  state?: string | null
  error?: string | null
}

export interface DesktopSignInOptions {
  invoke: Invoke
  /** Opens a URL in the system browser (the opener plugin). */
  openUrl: (url: string) => Promise<unknown>
  fetch?: Fetch
}

export function desktopSignIn({ invoke, openUrl, fetch }: DesktopSignInOptions): BrowserSignIn {
  return {
    async start(server) {
      const port = (await invoke("oauth_listen")) as number
      const redirectUri = `http://127.0.0.1:${port}/callback`
      const { verifier, challenge } = await createPkce()
      const state = randomState()
      const clientId = "campflare-desktop"
      const waiting = invoke("oauth_wait")
      // Without an answer from the browser, nothing is listening for it either.
      waiting.catch(() => {})
      try {
        await openUrl(authorizeUrl(server, { clientId, redirectUri, state, challenge, userScopes: USER_SCOPES }))
      } catch (err) {
        await invoke("oauth_cancel")
        throw err
      }
      const back = (await waiting) as Callback
      const q = new URLSearchParams()
      for (const [k, v] of Object.entries(back)) if (typeof v === "string") q.set(k, v)
      const code = callbackCode(q, state)
      const res = await exchangeCode(server, { clientId, code, redirectUri, verifier, fetch })
      return { url: serverRoot(server), token: res.authed_user.access_token, via: "oauth" }
    },
    returning: () => false,
    finish: () => Promise.reject(new OAuthError("state_mismatch")),
    cancel() {
      invoke("oauth_cancel").catch(() => {})
    },
  }
}

interface TauriGlobal {
  core?: { invoke?: Invoke }
  opener?: { openUrl?: (url: string) => Promise<unknown> }
}

/** The loopback flow in the desktop shell, the redirect flow in a browser (found as `platformStore` does). */
export function platformSignIn(
  global: { __TAURI__?: TauriGlobal } = globalThis as never,
  fetch?: Fetch,
): BrowserSignIn {
  const invoke = global.__TAURI__?.core?.invoke
  const openUrl = global.__TAURI__?.opener?.openUrl
  return invoke && openUrl ? desktopSignIn({ invoke, openUrl, fetch }) : webSignIn({ fetch })
}

/** Why a sign-in through the browser didn't finish, for the login screen. */
export function signInError(err: unknown): string {
  const code = err instanceof OAuthError || err instanceof ApiError ? err.code : undefined
  switch (code) {
    case "access_denied":
      return "You chose Deny in the browser, so you're not signed in."
    case "state_mismatch":
      return "That sign-in didn't start here, or it was already used. Try again."
    case "invalid_code":
      return "The sign-in expired or was already used. Try again."
    case undefined:
      if (err instanceof TypeError) return "Couldn't reach the server"
      return `Sign-in didn't finish: ${err instanceof Error ? err.message : String(err)}`
    default:
      return `Sign-in failed: ${code}`
  }
}
