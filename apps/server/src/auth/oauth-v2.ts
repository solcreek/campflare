import type { Hono } from "hono"
import { publicOrigin } from "../api/origin"
import type { Env } from "../env"
import { AUTH_BASE_PATH } from "./index"

// Slack's OAuth v2, for apps that sign a person in and want a user token
// (xoxp-), as Slack's own "Sign in" and user-token installs do:
//
//   GET /oauth/v2/authorize?client_id&redirect_uri&state&user_scope
//       &code_challenge&code_challenge_method=S256
//     → the browser signs in and consents (/login, /consent), then comes back
//       to redirect_uri with ?code&state
//   POST /api/oauth.v2.access  client_id, code, redirect_uri, code_verifier
//     → { authed_user: { id, scope, access_token: "xoxp-…", token_type: "user" }, team }
//
// Better Auth is the authorization server underneath: this endpoint only
// translates Slack's parameters into its /auth/oauth2/authorize, so sign-in,
// consent (remembered per client), client lookup (registered rows or Client ID
// Metadata Documents), redirect URI matching (any port on loopback, RFC 8252),
// PKCE and single-use, hashed, 10-minute codes are all its own. oauth.v2.access
// (methods/oauth.ts) redeems the code at its token endpoint and mints the xoxp.

/** Slack separates scopes with commas; OAuth with spaces. */
export const splitScopes = (s: string | null | undefined) => (s ?? "").split(/[\s,]+/).filter(Boolean)

export function mountOAuthV2(app: Hono<{ Bindings: Env }>) {
  app.get("/oauth/v2/authorize", (c) => {
    const url = new URL(c.req.url)
    const q = url.searchParams
    // Bot scopes install an app into a workspace; here an app signs a person in, nothing more.
    if (splitScopes(q.get("scope")).length) {
      return c.text("Campflare signs a person in only: ask for user_scope, not scope (bot scopes).", 400)
    }
    const target = new URL(`${AUTH_BASE_PATH}/oauth2/authorize`, publicOrigin(c.req.raw))
    const pass = ["client_id", "redirect_uri", "state", "code_challenge", "code_challenge_method"]
    target.searchParams.set("response_type", "code")
    for (const name of pass) {
      const value = q.get(name)
      if (value !== null) target.searchParams.set(name, value)
    }
    // openid: the code's redemption then names the person (an ID token), which is how the xoxp finds its user.
    target.searchParams.set("scope", [...new Set(["openid", ...splitScopes(q.get("user_scope"))])].join(" "))
    return c.redirect(target.toString(), 302)
  })
}
