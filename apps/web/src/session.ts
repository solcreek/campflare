// Who the app is signed in as: a server and a user token.
//
// The web app keeps it in localStorage; the desktop shell keeps it in the OS
// keychain behind the same SessionStore. In development, the `pnpm dev:all`
// server's people sign in by themselves: `?as=vincent` picks one.

import { createClient, type Fetch } from "@campflare/client"

export interface Session {
  url: string
  token: string
  /**
   * How the token was obtained: "oauth" from signing in through the browser,
   * so signing out revokes it; "token" (or absent, as in sessions kept by
   * older builds) pasted by the person, who may share it with scripts, so the
   * app never revokes it.
   */
  via?: "oauth" | "token"
}

/** Where the session is kept. Async because the desktop keychain is behind IPC. */
export interface SessionStore {
  load(): Promise<Session | null>
  save(session: Session): Promise<void>
  clear(): Promise<void>
}

const KEY = "campflare.session"

/** A session from untrusted JSON, or null unless it has url and token as strings. */
function asSession(value: unknown): Session | null {
  const { url, token, via } = (value ?? {}) as Partial<Record<keyof Session, unknown>>
  if (!(typeof url === "string" && url && typeof token === "string" && token)) return null
  return via === "oauth" || via === "token" ? { url, token, via } : { url, token }
}

/** How long signing out waits for the server to revoke the token. */
export const REVOKE_TIMEOUT_MS = 5000

/**
 * Ends a session on its server before the app forgets it: auth.revoke for a
 * token from the browser sign-in, nothing for a pasted one. Best effort: it
 * never throws and gives up after `timeoutMs`, so a server that's down or
 * answers an error never keeps anyone signed in. Resolves whether the token was revoked.
 */
export async function revokeSession(
  session: Session,
  { fetch = globalThis.fetch, timeoutMs = REVOKE_TIMEOUT_MS }: { fetch?: Fetch; timeoutMs?: number } = {},
): Promise<boolean> {
  if (session.via !== "oauth") return false
  const abort = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => {
      abort.abort()
      resolve(false)
    }, timeoutMs)
  })
  const client = createClient({
    url: session.url,
    token: session.token,
    maxRetries: 0,
    fetch: (input, init) => fetch(input, { ...init, signal: abort.signal }),
  })
  const revoked = client.call("auth.revoke").then(
    () => true,
    () => false,
  )
  try {
    return await Promise.race([revoked, timeout])
  } finally {
    clearTimeout(timer)
  }
}

export function browserStore(
  storage: Pick<Storage, "getItem" | "setItem" | "removeItem"> = localStorage,
): SessionStore {
  return {
    async load() {
      try {
        return asSession(JSON.parse(storage.getItem(KEY) ?? "null"))
      } catch {
        return null
      }
    },
    save: async (session) => storage.setItem(KEY, JSON.stringify(session)),
    clear: async () => storage.removeItem(KEY),
  }
}

/** Tauri's `core.invoke`: runs a command of the desktop shell (apps/desktop/src-tauri). */
export type Invoke = (command: string, args?: Record<string, unknown>) => Promise<unknown>

/**
 * The session in the OS keychain, through the shell's `session_*` commands.
 *
 * Builds before the keychain kept the session in localStorage (`legacy`): the
 * first load moves it into the keychain, and localStorage is cleared once the
 * keychain has it. If the keychain refuses it, the old session still signs in
 * and the move is tried again next launch.
 */
export function desktopStore(invoke: Invoke, legacy: SessionStore = browserStore()): SessionStore {
  return {
    async load() {
      const kept = asSession(await invoke("session_load"))
      const old = await legacy.load()
      if (kept || !old) {
        if (old) await legacy.clear()
        return kept
      }
      try {
        await invoke("session_save", { session: old })
      } catch {
        return old
      }
      await legacy.clear()
      return old
    },
    save: async (session) => {
      await invoke("session_save", { session })
    },
    // The legacy copy too: one the keychain refused would otherwise sign back in.
    clear: async () => {
      await Promise.all([invoke("session_clear"), legacy.clear()])
    },
  }
}

interface TauriGlobal {
  core?: { invoke?: Invoke }
}

/**
 * The keychain in the desktop shell, localStorage in a browser. The shell is
 * found at runtime (`withGlobalTauri` puts `__TAURI__` on window), so the web
 * build never depends on `@tauri-apps/*`.
 */
export function platformStore(global: { __TAURI__?: TauriGlobal } = globalThis as never): SessionStore {
  const invoke = global.__TAURI__?.core?.invoke
  return invoke ? desktopStore(invoke) : browserStore()
}

export type DevAccounts = NonNullable<typeof __CAMPFLARE_DEV__>

/**
 * The dev server's account named by `?as=` (the owner by default), when there is a dev server.
 * `?as=none` (or anyone unknown) shows the login screen instead, and so does the browser
 * coming back from a sign-in (`?state=`), which signs in as whoever the person chose.
 */
export function devSession(dev: DevAccounts | null, search: string): Session | null {
  const query = new URLSearchParams(search)
  if (!dev || query.has("state")) return null
  const as = query.get("as") ?? "alex"
  const token = dev.people[as]
  return token ? { url: dev.url, token } : null
}
