import { ApiError, createClient, type Fetch } from "@campflare/client"
import { type FormEvent, useEffect, useId, useRef, useState } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { servesApi } from "@/server-address"
import type { Session } from "@/session"
import { type BrowserSignIn, signInError } from "@/sign-in"

/**
 * Signs in to a server: through the browser (OAuth v2 with PKCE, the server's
 * own sign-in and consent pages), or with a pasted user token (xoxp-) checked
 * with auth.test before it's kept.
 */
export function LoginScreen({
  onSignIn,
  signIn,
  fetch,
  server = "",
  probeOrigin,
}: {
  onSignIn: (session: Session) => void
  signIn: BrowserSignIn
  fetch?: Fetch
  /** The Server field's first value: the dev server, or the last one signed in to. */
  server?: string
  /** Offered in the Server field, if it's still empty, once it answers api.test: the page's own origin. */
  probeOrigin?: string
}) {
  const [initial] = useState(server)
  const [url, setUrl] = useState(initial)
  // Never pre-filled: a token is only ever typed or pasted.
  const [token, setToken] = useState("")
  const [error, setError] = useState<string>()
  // Read once: finishing cleans the query out of the address bar, and StrictMode runs the effect twice.
  const [returning] = useState(() => signIn.returning())
  const [busy, setBusy] = useState<"browser" | "token" | "returning" | undefined>(returning ? "returning" : undefined)
  const id = useId()

  // A web app served next to its server: suggest that server, unless the person has started typing.
  useEffect(() => {
    if (initial || !probeOrigin || returning) return
    let live = true
    void servesApi(probeOrigin, fetch).then((ok) => {
      if (live && ok) setUrl((typed) => typed || probeOrigin)
    })
    return () => {
      live = false
    }
  }, [initial, probeOrigin, returning, fetch])

  // The browser came back to this page: finish what an earlier page started.
  useEffect(() => {
    if (!returning) return
    let live = true
    signIn.finish().then(
      (session) => live && onSignIn(session),
      (err: unknown) => {
        if (!live) return
        setError(signInError(err))
        setBusy(undefined)
      },
    )
    return () => {
      live = false
    }
  }, [returning, signIn, onSignIn])

  // Each browser sign-in's number: one the person cancelled says nothing when it ends.
  const attempt = useRef(0)
  const withBrowser = async (e: FormEvent) => {
    e.preventDefault()
    const mine = ++attempt.current
    setBusy("browser")
    setError(undefined)
    try {
      const session = await signIn.start(url.trim())
      // Null: the page is on its way to the server's sign-in; stay busy until it goes.
      if (!session || mine !== attempt.current) return
      onSignIn(session)
    } catch (err) {
      if (mine !== attempt.current) return
      setError(signInError(err))
    }
    setBusy(undefined)
  }
  const cancel = () => {
    attempt.current++
    signIn.cancel()
    setBusy(undefined)
  }

  const withToken = async (e: FormEvent) => {
    e.preventDefault()
    const session = { url: url.trim(), token: token.trim() }
    if (!session.url) {
      setError("Enter the server's address")
      return
    }
    setBusy("token")
    setError(undefined)
    try {
      await createClient({ ...session, fetch }).call("auth.test")
      onSignIn(session)
    } catch (err) {
      setError(err instanceof ApiError ? err.code : "Couldn't reach the server")
    } finally {
      setBusy(undefined)
    }
  }

  if (busy === "returning") {
    return (
      <main className="flex min-h-svh items-center justify-center text-muted-foreground" aria-busy="true">
        Finishing sign-in…
      </main>
    )
  }

  return (
    <main className="flex min-h-svh items-center justify-center p-6">
      <div className="w-full max-w-sm space-y-6">
        <form id={`${id}-browser`} onSubmit={withBrowser} className="space-y-4">
          <h1 className="text-2xl font-semibold">Sign in to Campflare</h1>
          <label htmlFor={`${id}-url`} className="block space-y-1 text-sm">
            <span>Server</span>
            <Input
              id={`${id}-url`}
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://campflare.example.com"
              required
            />
          </label>
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          {busy === "browser" ? (
            <div className="space-y-2">
              <Button type="button" className="w-full" disabled>
                Waiting for your browser…
              </Button>
              <Button type="button" variant="ghost" className="w-full" onClick={cancel}>
                Cancel
              </Button>
            </div>
          ) : (
            <Button type="submit" className="w-full" disabled={busy === "token"}>
              Sign in with your browser
            </Button>
          )}
        </form>
        <div className="flex items-center gap-3 text-xs text-muted-foreground" aria-hidden="true">
          <span className="h-px flex-1 bg-border" />
          or
          <span className="h-px flex-1 bg-border" />
        </div>
        <form onSubmit={withToken} className="space-y-3">
          <label htmlFor={`${id}-token`} className="block space-y-1 text-sm">
            <span>Token</span>
            <Input
              id={`${id}-token`}
              type="password"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              placeholder="xoxp-…"
              autoComplete="off"
              required
            />
          </label>
          <Button type="submit" variant="outline" className="w-full" disabled={busy !== undefined}>
            {busy === "token" ? "Signing in…" : "Sign in with a token"}
          </Button>
        </form>
      </div>
    </main>
  )
}
