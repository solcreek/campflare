import {
  ApiError,
  authorizeUrl,
  callbackCode,
  createClient,
  createPkce,
  exchangeCode,
  OAuthError,
  randomState,
} from "@campflare/client"
import { createServer, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import type { Io } from "./io"

// `campflare login --oauth`: sign in through the browser, as Slack's OAuth v2
// does, and end up with a user token. The CLI is a public client
// (campflare-cli): it can't keep a secret, so PKCE proves the code is its own,
// and the browser comes back to a listener on a free loopback port (RFC 8252).
// The protocol itself (PKCE, the authorize URL, the exchange) is the client
// library's, shared with the app.

export const CLIENT_ID = "campflare-cli"

/** What the CLI's commands use: reading and writing conversations, reactions, files, search, people. */
export const USER_SCOPES = [
  "channels:history",
  "channels:read",
  "channels:write",
  "chat:write",
  "files:read",
  "files:write",
  "groups:history",
  "groups:read",
  "groups:write",
  "im:history",
  "im:read",
  "im:write",
  "mpim:history",
  "mpim:read",
  "mpim:write",
  "reactions:read",
  "reactions:write",
  "search:read",
  "team:read",
  "users:read",
]

const PAGE = (message: string) =>
  `<!doctype html><meta charset="utf-8"><title>Campflare</title><p style="font:16px system-ui;margin:3rem">${message}</p>`

/** Waits for the browser's one request to /callback; answers it and resolves with its query. */
function callback(server: Server): Promise<URLSearchParams> {
  return new Promise((resolve) => {
    server.on("request", (req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1")
      if (url.pathname !== "/callback") {
        res.writeHead(404).end()
        return
      }
      const failed = url.searchParams.has("error")
      res
        .writeHead(200, { "content-type": "text/html; charset=utf-8" })
        .end(PAGE(failed ? "Sign-in didn't finish. Return to the terminal." : "Signed in. You can close this tab."))
      resolve(url.searchParams)
    })
  })
}

/** How long revoking waits for the server before the CLI forgets the token anyway. */
export const REVOKE_TIMEOUT_MS = 5000

/**
 * auth.revoke for a token the CLI is about to forget. Best effort: never
 * throws; says why it didn't revoke (unreachable, timed out, or the server's
 * error code). A token the server already rejects counts as revoked.
 */
export async function revokeToken(
  io: Io,
  url: string,
  token: string,
  timeoutMs = REVOKE_TIMEOUT_MS,
): Promise<{ revoked: true } | { revoked: false; reason: string }> {
  const fetch = io.fetch ?? globalThis.fetch
  const abort = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<{ revoked: false; reason: string }>((resolve) => {
    timer = setTimeout(() => {
      abort.abort()
      resolve({ revoked: false, reason: `no answer in ${timeoutMs / 1000} s` })
    }, timeoutMs)
  })
  const client = createClient({
    url,
    token,
    maxRetries: 0,
    fetch: (input, init) => fetch(input, { ...init, signal: abort.signal }),
  })
  const call = client.call("auth.revoke").then(
    () => ({ revoked: true }) as const,
    (err: unknown) => {
      if (err instanceof ApiError) {
        if (err.code === "invalid_auth" || err.code === "token_revoked") return { revoked: true } as const
        return { revoked: false, reason: err.code } as const
      }
      return { revoked: false, reason: err instanceof Error ? err.message : String(err) } as const
    },
  )
  try {
    return await Promise.race([call, timeout])
  } finally {
    clearTimeout(timer)
  }
}

/** Runs the browser sign-in against a server and returns the new user token. */
export async function oauthLogin(io: Io, url: string, opts: { port?: number } = {}): Promise<string> {
  const { verifier, challenge } = await createPkce()
  const state = randomState()

  const listener = createServer()
  await new Promise<void>((ok, fail) => {
    listener.once("error", fail)
    listener.listen(opts.port ?? 0, "127.0.0.1", () => ok())
  })
  try {
    const redirectUri = `http://127.0.0.1:${(listener.address() as AddressInfo).port}/callback`
    const authorize = authorizeUrl(url, { clientId: CLIENT_ID, redirectUri, state, challenge, userScopes: USER_SCOPES })

    // Listening for the browser, and for Ctrl-C, before the browser opens.
    const returned = Promise.race([
      callback(listener),
      io.interrupted().then(() => {
        throw new Error("sign-in cancelled")
      }),
    ])
    // Printed too, for a terminal with no browser: open it anywhere that can reach this machine's loopback.
    io.stderr(`Opening your browser to sign in. If it doesn't open, visit:\n\n  ${authorize}\n\n`)
    await io.openUrl?.(authorize)
    const query = await returned

    let code: string
    try {
      code = callbackCode(query, state)
    } catch (err) {
      if (err instanceof OAuthError && err.code === "access_denied")
        throw new Error(`${err.message} (you chose Deny)`, { cause: err })
      throw err
    }
    const res = await exchangeCode(url, { clientId: CLIENT_ID, code, redirectUri, verifier, fetch: io.fetch })
    return res.authed_user.access_token
  } finally {
    listener.closeAllConnections()
    listener.close()
  }
}
