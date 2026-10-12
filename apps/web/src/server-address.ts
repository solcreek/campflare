// The server the login screen suggests: the dev server in development, else
// the last one the person signed in to.
//
// The last server is not a secret, so localStorage keeps it on the web and in
// the desktop shell alike, and signing out leaves it. Tokens are never kept here.

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
