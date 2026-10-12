import { ApiError, createClient, type Fetch } from "@campflare/client"
import { type FormEvent, useId, useState } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import type { Session } from "@/session"

/**
 * Signs in with a server URL and a user token (xoxp-), checked with auth.test
 * before it's kept. OAuth sign-in through the server's /login comes later.
 */
export function LoginScreen({ onSignIn, fetch }: { onSignIn: (session: Session) => void; fetch?: Fetch }) {
  const [url, setUrl] = useState(() => (typeof location === "undefined" ? "" : location.origin))
  const [token, setToken] = useState("")
  const [error, setError] = useState<string>()
  const [busy, setBusy] = useState(false)
  const id = useId()

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setError(undefined)
    const session = { url: url.trim(), token: token.trim() }
    try {
      await createClient({ ...session, fetch }).call("auth.test")
      onSignIn(session)
    } catch (err) {
      setError(err instanceof ApiError ? err.code : "Couldn't reach the server")
    } finally {
      setBusy(false)
    }
  }

  return (
    <main className="flex min-h-svh items-center justify-center p-6">
      <form onSubmit={submit} className="w-full max-w-sm space-y-4">
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
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        <Button type="submit" className="w-full" disabled={busy}>
          {busy ? "Signing in…" : "Sign in"}
        </Button>
      </form>
    </main>
  )
}
