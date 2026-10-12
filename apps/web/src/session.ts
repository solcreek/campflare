// Who the app is signed in as: a server and a user token.
//
// The web app keeps it in localStorage; the desktop shell will swap in the OS
// keychain behind the same SessionStore. In development, the `pnpm dev:all`
// server's people sign in by themselves: `?as=vincent` picks one.

export interface Session {
  url: string
  token: string
}

/** Where the session is kept. Async because the desktop keychain is behind IPC. */
export interface SessionStore {
  load(): Promise<Session | null>
  save(session: Session): Promise<void>
  clear(): Promise<void>
}

const KEY = "campflare.session"

/** A session from untrusted JSON, or null unless it has both fields as strings. */
function asSession(value: unknown): Session | null {
  const { url, token } = (value ?? {}) as Partial<Record<keyof Session, unknown>>
  return typeof url === "string" && url && typeof token === "string" && token ? { url, token } : null
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

export type DevAccounts = NonNullable<typeof __CAMPFLARE_DEV__>

/** The dev server's account named by `?as=` (the owner by default), when there is a dev server. */
export function devSession(dev: DevAccounts | null, search: string): Session | null {
  if (!dev) return null
  const as = new URLSearchParams(search).get("as") ?? "alex"
  const token = dev.people[as]
  return token ? { url: dev.url, token } : null
}
