import { DEFAULT_USER_SCOPES, issueToken } from "../api/auth"
import { method } from "../api/context"
import { CampflareError } from "../api/errors"
import { AUTH_BASE_PATH } from "../auth"
import { CAMPFLARE_PROVIDER } from "../auth/campflare-token"
import { splitScopes } from "../auth/oauth-v2"
import { authFor } from "../auth/routes"
import { stmt } from "../db/query"
import type { TeamRow, UserRow } from "../db/rows"

// oauth.v2.access: the second half of Slack's OAuth v2 (see auth/oauth-v2.ts).
// The code is redeemed at Better Auth's token endpoint, which checks the
// client, the redirect URI, the PKCE verifier, and that the code is unused and
// unexpired. Its answer names the person (the ID token's sub), whose linked
// Campflare user gets a new user token, stored hashed like every token.

/** Better Auth's OAuth errors as Slack's oauth.v2.access error codes. */
function slackError(error: string | undefined, description: string | undefined): string {
  if (error === "invalid_client" || error === "unauthorized_client") return "invalid_client_id"
  // Better Auth says invalid_grant for most things; its description tells them apart.
  if (/client_id/i.test(description ?? "")) return "invalid_client_id"
  if (/redirect/i.test(description ?? "")) return "bad_redirect_uri"
  return "invalid_code"
}

/** The client's credentials: form fields, or HTTP Basic as Slack also accepts. */
function credentials(request: Request, clientId?: string, clientSecret?: string) {
  const basic = request.headers.get("authorization")?.match(/^Basic\s+(\S+)$/i)?.[1]
  if (!basic) return { clientId, clientSecret }
  try {
    const [id, secret = ""] = atob(basic).split(/:(.*)/s)
    return { clientId: decodeURIComponent(id!), clientSecret: decodeURIComponent(secret) }
  } catch {
    throw new CampflareError("invalid_client_id")
  }
}

/** The payload of a JWT this Worker just received from its own token endpoint, in process: no signature to doubt. */
function claimsOf(jwt: string): Record<string, unknown> {
  const part = jwt.split(".")[1] ?? ""
  return JSON.parse(atob(part.replace(/-/g, "+").replace(/_/g, "/"))) as Record<string, unknown>
}

/** How Better Auth keys what it issued for an authorization code: SHA-256, base64url without padding. */
async function authorizationCodeId(code: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(code)))
  return btoa(String.fromCharCode(...digest))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "")
}

method("oauth.v2.access", "none", async (ctx) => {
  const grantType = ctx.args.str("grant_type") ?? "authorization_code"
  // Campflare tokens don't expire, so there is nothing to refresh.
  if (grantType !== "authorization_code") throw new CampflareError("invalid_grant_type")
  const { clientId, clientSecret } = credentials(ctx.request, ctx.args.str("client_id"), ctx.args.str("client_secret"))
  if (!clientId) throw new CampflareError("invalid_client_id")
  const code = ctx.args.str("code")
  if (!code) throw new CampflareError("invalid_code")

  const form = new URLSearchParams({ grant_type: "authorization_code", code, client_id: clientId })
  for (const [name, value] of [
    ["redirect_uri", ctx.args.str("redirect_uri")],
    ["code_verifier", ctx.args.str("code_verifier")],
    ["client_secret", clientSecret],
  ] as const) {
    if (value) form.set(name, value)
  }
  const res = await authFor(ctx.env, ctx.request).handler(
    new Request(`${ctx.origin}${AUTH_BASE_PATH}/oauth2/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: form,
    }),
  )
  const answer = (await res.json().catch(() => ({}))) as {
    id_token?: string
    scope?: string
    error?: string
    error_description?: string
  }
  if (!res.ok || !answer.id_token) throw new CampflareError(slackError(answer.error, answer.error_description))
  const sub = String(claimsOf(answer.id_token).sub ?? "")

  // The person's Campflare user, their workspace, and the client's name for the token's label: one round trip.
  // The same trip deletes the access (and refresh) token Better Auth just issued for the code: the app gets
  // an xoxp instead, so nothing would ever use them. Consent stays, so the next sign-in skips the question.
  const linked = `SELECT "accountId" FROM "account" WHERE "providerId" = ? AND "userId" = ?`
  const codeId = await authorizationCodeId(code)
  const [users, teams, clients] = await ctx.env.DB.batch([
    stmt(ctx.env.DB, `SELECT * FROM users WHERE id = (${linked})`, CAMPFLARE_PROVIDER, sub),
    stmt(
      ctx.env.DB,
      `SELECT * FROM teams WHERE id = (SELECT team_id FROM users WHERE id = (${linked}))`,
      CAMPFLARE_PROVIDER,
      sub,
    ),
    stmt(ctx.env.DB, 'SELECT "name" FROM "oauthClient" WHERE "clientId" = ?', clientId),
    stmt(ctx.env.DB, 'DELETE FROM "oauthAccessToken" WHERE "authorizationCodeId" = ?', codeId),
    stmt(ctx.env.DB, 'DELETE FROM "oauthRefreshToken" WHERE "authorizationCodeId" = ?', codeId),
  ])
  const user = users!.results[0] as UserRow | undefined
  const team = teams!.results[0] as TeamRow | undefined
  if (!user || user.deleted || user.is_bot || !team) throw new CampflareError("account_inactive")
  const clientName = (clients!.results[0] as { name: string | null } | undefined)?.name || clientId

  const known = new Set(DEFAULT_USER_SCOPES)
  const scopes = splitScopes(answer.scope).filter((s) => known.has(s))
  const token = await issueToken(ctx.env, {
    teamId: team.id,
    kind: "user",
    userId: user.id,
    scopes,
    label: `OAuth: ${clientName}`,
  })
  return {
    app_id: clientId,
    authed_user: { id: user.id, scope: scopes.join(","), access_token: token, token_type: "user" },
    team: { id: team.id, name: team.name },
    enterprise: null,
    is_enterprise_install: false,
  }
})
