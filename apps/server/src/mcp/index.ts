import {
  createMcpHandler,
  getOAuthProtectedResourceMetadataUrl,
  OAuthError,
  OAuthErrorCode,
  originValidationResponse,
  requireBearerAuth,
  type AuthInfo,
} from "@modelcontextprotocol/server"
import { createLocalJWKSet, jwtVerify, type JWTPayload } from "jose"
import { actorFor, authenticate } from "../api/auth"
import { publicOrigin } from "../api/origin"
import { CAMPFLARE_PROVIDER } from "../auth/sign-in"
import { authFor } from "../auth/routes"
import { first } from "../db/query"
import type { Actor } from "../api/context"
import { CampflareError } from "../api/errors"
import type { Env } from "../env"
import type { Caller } from "./invoke"
import { buildServer } from "./tools"

// The remote MCP server: Streamable HTTP at /mcp, per the 2026-07-28
// specification (with the SDK's stateless fallback for 2025-era clients).
// It is an OAuth resource server. A bearer token is either an access token
// from our authorization server (Better Auth, at /auth: a JWT bound to this
// /mcp resource), or a Campflare user or bot token (xoxp-/xoxb-) for agents
// configured by hand.

/** How long a verified token is vouched for: our tokens don't expire, but the SDK requires an expiry. */
const VOUCH_SECONDS = 300

/** An OAuth access token: a JWT from our issuer, for this resource, naming a person linked to a Campflare user. */
async function verifyJwt(env: Env, request: Request, token: string): Promise<AuthInfo> {
  const origin = publicOrigin(request)
  const auth = authFor(env, request)
  const jwks = createLocalJWKSet((await auth.api.getJwks()) as Parameters<typeof createLocalJWKSet>[0])
  let claims: JWTPayload
  try {
    ;({ payload: claims } = await jwtVerify(token, jwks, { issuer: `${origin}/auth`, audience: `${origin}/mcp` }))
  } catch {
    throw new OAuthError(OAuthErrorCode.InvalidToken, "invalid or expired access token")
  }
  const link = await first<{ accountId: string }>(
    env.DB,
    'SELECT "accountId" FROM "account" WHERE "userId" = ? AND "providerId" = ?',
    claims.sub,
    CAMPFLARE_PROVIDER,
  )
  if (!link) throw new OAuthError(OAuthErrorCode.InvalidToken, "no Campflare user behind this token")
  let actor
  try {
    actor = await actorFor(env, link.accountId)
  } catch (error) {
    if (error instanceof CampflareError) throw new OAuthError(OAuthErrorCode.InvalidToken, error.code)
    throw error
  }
  return {
    token,
    clientId: String(claims.azp ?? claims.client_id ?? "oauth"),
    scopes: typeof claims.scope === "string" ? claims.scope.split(" ") : [],
    expiresAt: claims.exp,
    resource: new URL(`${origin}/mcp`),
    extra: { auth: actor },
  }
}

async function verify(env: Env, request: Request, token: string): Promise<AuthInfo> {
  if (!/^xox[a-z]-|^xapp-/.test(token)) return verifyJwt(env, request, token)
  let auth
  try {
    auth = await authenticate(env, token)
  } catch (error) {
    if (error instanceof CampflareError) throw new OAuthError(OAuthErrorCode.InvalidToken, error.code)
    throw error
  }
  if (!auth.user || auth.kind === "app") throw new OAuthError(OAuthErrorCode.InvalidToken, "use a user or bot token")
  return {
    token,
    clientId: auth.app?.id ?? `user:${auth.user.id}`,
    scopes: auth.scopes,
    expiresAt: Math.floor(Date.now() / 1000) + VOUCH_SECONDS,
    extra: { auth },
  }
}

export async function handleMcp(
  env: Env,
  request: Request,
  waitUntil: (promise: Promise<unknown>) => void,
): Promise<Response> {
  const origin = new URL(publicOrigin(request))
  // Browsers may only call from this origin: guards against DNS rebinding, as the spec asks.
  const rejected = originValidationResponse(request, [origin.hostname])
  if (rejected) return rejected

  const gate = requireBearerAuth({
    verifier: { verifyAccessToken: (token) => verify(env, request, token) },
    // 401s point MCP clients at the metadata that names our authorization server.
    resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(new URL(`${origin.origin}/mcp`)),
  })
  const authInfo = await gate(request)
  if (authInfo instanceof Response) return authInfo

  const handler = createMcpHandler(({ authInfo: info }) => {
    const caller: Caller = {
      env,
      // The gate above only lets verified requests through, and verify() always sets extra.auth.
      auth: (info!.extra as { auth: Actor }).auth,
      origin: origin.origin,
      request,
      waitUntil,
    }
    return buildServer(caller)
  })
  return handler.fetch(request, { authInfo })
}
