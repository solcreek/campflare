import {
  createMcpHandler,
  OAuthError,
  OAuthErrorCode,
  originValidationResponse,
  requireBearerAuth,
  type AuthInfo,
} from "@modelcontextprotocol/server"
import { authenticate } from "../api/auth"
import type { Actor } from "../api/context"
import { CampflareError } from "../api/errors"
import type { Env } from "../env"
import type { Caller } from "./invoke"
import { buildServer } from "./tools"

// The remote MCP server: Streamable HTTP at /mcp, per the 2026-07-28
// specification (with the SDK's stateless fallback for 2025-era clients).
// It is an OAuth resource server; for now the bearer token is a Campflare
// user or bot token (xoxp-/xoxb-), checked by the same code as the Web API.

/** How long a verified token is vouched for: our tokens don't expire, but the SDK requires an expiry. */
const VOUCH_SECONDS = 300

async function verify(env: Env, token: string): Promise<AuthInfo> {
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
  const origin = new URL(request.url)
  // Browsers may only call from this origin: guards against DNS rebinding, as the spec asks.
  const rejected = originValidationResponse(request, [origin.hostname])
  if (rejected) return rejected

  const gate = requireBearerAuth({ verifier: { verifyAccessToken: (token) => verify(env, token) } })
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
