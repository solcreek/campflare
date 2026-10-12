// Who the app is signed in as: a server and a user token.
//
// The web app keeps it in localStorage; the desktop shell will swap in the OS
// keychain behind the same SessionStore. In development, the `pnpm dev:all`
// server's people sign in by themselves: `?as=vincent` picks one.

export interface Session {
  url: string
  token: string
}

export interface SessionStore {
  load(): Session | null
  save(session: Session): void
  clear(): void
}

const KEY = "campflare.session"

export function browserStore(
  storage: Pick<Storage, "getItem" | "setItem" | "removeItem"> = localStorage,
): SessionStore {
  return {
    load() {
      try {
        const parsed = JSON.parse(storage.getItem(KEY) ?? "null") as Partial<Session> | null
        return parsed?.url && parsed.token ? { url: parsed.url, token: parsed.token } : null
      } catch {
        return null
      }
    },
    save: (session) => storage.setItem(KEY, JSON.stringify(session)),
    clear: () => storage.removeItem(KEY),
  }
}

export type DevAccounts = NonNullable<typeof __CAMPFLARE_DEV__>

/** The dev server's account named by `?as=` (the owner by default), when there is a dev server. */
export function devSession(dev: DevAccounts | null, search: string): Session | null {
  if (!dev) return null
  const as = new URLSearchParams(search).get("as") ?? "alex"
  const token = dev.people[as]
  return token ? { url: dev.url, token } : null
}
