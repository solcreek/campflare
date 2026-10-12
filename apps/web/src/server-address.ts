// The server the login screen suggests: the dev server in development, else
// the last one the person signed in to, else (on the web) the page's own
// origin when it serves the Web API too, as a web app deployed next to its
// server does.
//
// The last server is not a secret, so localStorage keeps it on the web and in
// the desktop shell alike, and signing out leaves it. Tokens are never kept here.

import { createClient, type Fetch } from "@campflare/client"

const KEY = "campflare.server"

type Storage = Pick<globalThis.Storage, "getItem" | "setItem">

/** The server last signed in to, or "" (also when storage can't be read). */
export function lastServer(storage: Storage = localStorage): string {
  try {
    return storage.getItem(KEY) ?? ""
  } catch {
    return ""
  }
}

/** Keeps the server just signed in to for the next login screen; storage that refuses it is no loss. */
export function rememberServer(url: string, storage: Storage = localStorage) {
  try {
    storage.setItem(KEY, url)
  } catch {
    // Private browsing or a full quota: the next login screen just starts empty.
  }
}

/**
 * The page's origin when it may also be a server's: a web page on http(s). Not in the
 * desktop shell, whose origin is its own (tauri://localhost, http://tauri.localhost).
 */
export function webOrigin(
  global: { __TAURI__?: unknown; location?: Pick<Location, "origin" | "protocol"> } = globalThis as never,
): string | undefined {
  const { location } = global
  if (global.__TAURI__ || !location || !/^https?:$/.test(location.protocol)) return undefined
  return location.origin
}

/** True when `origin` answers api.test: one request, no token, no retries. */
export async function servesApi(origin: string, fetch?: Fetch): Promise<boolean> {
  try {
    await createClient({ url: origin, fetch, maxRetries: 0 }).call("api.test")
    return true
  } catch {
    return false
  }
}
