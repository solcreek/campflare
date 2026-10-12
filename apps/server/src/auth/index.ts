import { cimd } from "@better-auth/cimd"
import { mcp } from "@better-auth/mcp"
import type { ClientMetadataResourceFetch } from "@better-auth/oauth-provider"
import { betterAuth } from "better-auth"
import { jwt } from "better-auth/plugins"
import { DEFAULT_USER_SCOPES } from "../api/auth"
import type { Env } from "../env"
import { campflareSignIn } from "./sign-in"
import { fetchClientMetadataResource } from "./cimd-fetch"

// Better Auth is the OAuth 2.1 authorization server for MCP clients: it signs
// people in, asks for consent, and issues JWT access tokens bound to this
// server's /mcp resource. It is built per request so its URLs follow the host
// the request came to.

export const AUTH_BASE_PATH = "/auth"

export interface AuthOverrides {
  /** CIMD's network boundary; tests serve client metadata documents without the network. */
  fetchClientMetadataResource?: ClientMetadataResourceFetch
}

export function createAuth(env: Env, origin: string, overrides: AuthOverrides = {}) {
  return betterAuth({
    appName: "Campflare",
    baseURL: origin,
    basePath: AUTH_BASE_PATH,
    secret: env.SIGNING_KEY,
    database: env.DB,
    telemetry: { enabled: false },
    plugins: [
      jwt(),
      mcp({
        loginPage: "/login",
        consentPage: "/consent",
        resource: `${origin}/mcp`,
        // OpenID's defaults, and Slack's user scopes for apps signing a person in (/oauth/v2/authorize).
        scopes: ["openid", "profile", "email", "offline_access", ...DEFAULT_USER_SCOPES],
      }),
      cimd({
        fetchClientMetadataResource: overrides.fetchClientMetadataResource ?? fetchClientMetadataResource,
        metadataProfile: "mcp-2026-07-28",
      }),
      campflareSignIn(env),
    ],
  })
}

export type Auth = ReturnType<typeof createAuth>
