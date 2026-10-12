import { createClient } from "@campflare/client"
import { createHash, randomBytes } from "node:crypto"
import { createServer, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import type { Io } from "./io"

// `campflare login --oauth`: sign in through the browser, as Slack's OAuth v2
// does, and end up with a user token. The CLI is a public client
// (campflare-cli): it can't keep a secret, so PKCE proves the code is its own,
// and the browser comes back to a listener on a free loopback port (RFC 8252).

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

/** Runs the browser sign-in against a server and returns the new user token. */
export async function oauthLogin(io: Io, url: string, opts: { port?: number } = {}): Promise<string> {
  const server = url.replace(/\/+$/, "").replace(/\/api$/, "")
  const verifier = randomBytes(32).toString("base64url")
  const challenge = createHash("sha256").update(verifier).digest("base64url")
  const state = randomBytes(16).toString("base64url")

  const listener = createServer()
  await new Promise<void>((ok, fail) => {
    listener.once("error", fail)
    listener.listen(opts.port ?? 0, "127.0.0.1", () => ok())
  })
  try {
    const redirectUri = `http://127.0.0.1:${(listener.address() as AddressInfo).port}/callback`
    const authorize = new URL("/oauth/v2/authorize", server)
    authorize.search = new URLSearchParams({
      client_id: CLIENT_ID,
      redirect_uri: redirectUri,
      user_scope: USER_SCOPES.join(","),
      state,
      code_challenge: challenge,
      code_challenge_method: "S256",
    }).toString()

    // Listening for the browser, and for Ctrl-C, before the browser opens.
    const returned = Promise.race([
      callback(listener),
      io.interrupted().then(() => {
        throw new Error("sign-in cancelled")
      }),
    ])
    // Printed too, for a terminal with no browser: open it anywhere that can reach this machine's loopback.
    io.stderr(`Opening your browser to sign in. If it doesn't open, visit:\n\n  ${authorize}\n\n`)
    await io.openUrl?.(authorize.toString())
    const query = await returned

    if (query.get("state") !== state) throw new Error("sign-in failed: the browser came back with the wrong state")
    const error = query.get("error")
    if (error) throw new Error(`sign-in failed: ${error}${error === "access_denied" ? " (you chose Deny)" : ""}`)
    const res = await createClient({ url, fetch: io.fetch }).call<{
      ok: boolean
      authed_user: { access_token: string }
    }>("oauth.v2.access", {
      client_id: CLIENT_ID,
      code: query.get("code") ?? "",
      redirect_uri: redirectUri,
      code_verifier: verifier,
    })
    return res.authed_user.access_token
  } finally {
    listener.closeAllConnections()
    listener.close()
  }
}
