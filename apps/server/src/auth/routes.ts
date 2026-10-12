import type { Hono } from "hono"
import { publicOrigin } from "../api/origin"
import { first } from "../db/query"
import type { Env } from "../env"
import { AUTH_BASE_PATH, createAuth, type AuthOverrides } from "./index"
import { consentPage, loginPage } from "./pages"

let overrides: AuthOverrides = {}

/** For tests, which run in the Worker's isolate: e.g. serve CIMD documents without the network. */
export function setAuthOverrides(next: AuthOverrides) {
  overrides = next
}

export const authFor = (env: Env, request: Request) => createAuth(env, publicOrigin(request), overrides)

export function mountAuth(app: Hono<{ Bindings: Env }>) {
  // Better Auth's own endpoints: sign-in, OAuth authorize/token/consent, JWKS.
  app.on(["GET", "POST"], "/auth/*", (c) => authFor(c.env, c.req.raw).handler(c.req.raw))

  // Discovery at the origin root: RFC 9728 protected resource metadata for /mcp,
  // and RFC 8414 authorization server metadata for the /auth issuer.
  app.get("/.well-known/*", (c) => authFor(c.env, c.req.raw).handler(c.req.raw))

  app.get("/login", (c) => loginPage(new URL(c.req.url)))

  app.post("/login", async (c) => {
    const form = await c.req.formData()
    const oauthQuery = String(form.get("oauth_query") ?? "")
    const res = await forward(c.env, c.req.raw, "/sign-in/campflare-token", {
      token: String(form.get("token") ?? ""),
      ...(oauthQuery ? { oauth_query: oauthQuery } : {}),
    })
    if (res.status >= 400) {
      const reason = ((await res.json().catch(() => ({}))) as { message?: string }).message
      return loginPage(new URL(`/login?${oauthQuery}`, c.req.url), signInError(reason))
    }
    return res
  })

  // Showing the page changes nothing; the decision posted from it is checked
  // by Better Auth against the signed query.
  app.get("/consent", async (c) => {
    const url = new URL(c.req.url)
    const clientId = url.searchParams.get("client_id") ?? ""
    const client = await first<{ name: string | null; uri: string | null }>(
      c.env.DB,
      'SELECT "name", "uri" FROM "oauthClient" WHERE "clientId" = ?',
      clientId,
    )
    if (!client) return c.text("unknown client", 400)
    return consentPage(url, { name: client.name || clientId, uri: client.uri })
  })

  app.post("/consent", async (c) => {
    const form = await c.req.formData()
    return forward(c.env, c.req.raw, "/oauth2/consent", {
      accept: form.get("accept") === "true",
      oauth_query: String(form.get("oauth_query") ?? ""),
    })
  })
}

/**
 * Calls a Better Auth endpoint for a form post, as JSON (all it accepts), and
 * hands its answer to the browser: cookies kept, and a { url } answer turned
 * into the redirect a navigating browser expects.
 */
async function forward(env: Env, original: Request, path: string, body: Record<string, unknown>): Promise<Response> {
  const url = new URL(`${AUTH_BASE_PATH}${path}`, original.url)
  const headers = new Headers({ "content-type": "application/json", accept: "application/json" })
  for (const name of ["cookie", "origin", "user-agent"]) {
    const value = original.headers.get(name)
    if (value) headers.set(name, value)
  }
  const res = await authFor(env, original).handler(
    new Request(url, { method: "POST", headers, body: JSON.stringify(body) }),
  )
  if (res.status >= 300 && res.status < 400) return res
  const answer = res.ok
    ? ((await res
        .clone()
        .json()
        .catch(() => ({}))) as { url?: string })
    : {}
  if (!answer.url) return res
  const redirect = new Headers({ location: answer.url })
  for (const cookie of res.headers.getSetCookie()) redirect.append("set-cookie", cookie)
  return new Response(null, { status: 302, headers: redirect })
}

function signInError(code: string | undefined): string {
  if (code === "token_revoked") return "That token has been revoked."
  if (code === "account_inactive") return "That account is deactivated."
  if (code === "a user token (xoxp-) is needed") return "That's not a user token: use one that starts with xoxp-."
  return "That token didn't work. Check it and try again."
}
