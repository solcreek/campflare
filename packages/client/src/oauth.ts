import { type ApiResult, createClient, type Fetch } from "./web"

// Slack's OAuth v2 for a public client signing a person in and getting a user
// token (xoxp-): the parts every platform shares. Opening the browser and
// receiving its callback are the app's own (a loopback listener in a CLI or a
// desktop app, the page's own URL in a web app).
//
//   1. createPkce() and randomState(), kept until the browser comes back
//   2. the browser opens authorizeUrl(...)
//   3. it returns to redirect_uri with ?code&state, or ?error&state: callbackCode()
//   4. exchangeCode(...) redeems the code at oauth.v2.access
//
// WebCrypto only (crypto.getRandomValues, crypto.subtle), so it runs in
// browsers, workerd and Node alike. Browsers expose crypto.subtle only in a
// secure context: https, or http on localhost.

/** What oauth.v2.access answers for a user token, as Slack does. */
export interface OAuthV2Access extends ApiResult {
  app_id: string
  authed_user: { id: string; scope: string; access_token: string; token_type: "user" }
  team: { id: string; name: string }
  enterprise: null
  is_enterprise_install: boolean
}

/** A sign-in that can't go on: the browser's `error` (access_denied…), or `state_mismatch`. */
export class OAuthError extends Error {
  readonly code: string

  constructor(code: string, message = `sign-in failed: ${code}`) {
    super(message)
    this.code = code
  }
}

export interface Pkce {
  /** Kept by the app until it redeems the code. */
  verifier: string
  /** Sent in the authorize URL: base64url(SHA-256(verifier)), method S256. */
  challenge: string
}

function base64url(bytes: Uint8Array): string {
  let binary = ""
  for (const b of bytes) binary += String.fromCharCode(b)
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

const randomBase64url = (size: number) => base64url(crypto.getRandomValues(new Uint8Array(size)))

/** A PKCE verifier (32 random bytes, 43 characters) and its S256 challenge. */
export async function createPkce(): Promise<Pkce> {
  const verifier = randomBase64url(32)
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))
  return { verifier, challenge: base64url(new Uint8Array(digest)) }
}

/** An unguessable `state`, to tie the browser's return to the sign-in that sent it. */
export const randomState = () => randomBase64url(16)

/** The server's root from what people type: "https://x.test/api/" → "https://x.test". */
export const serverRoot = (url: string) => url.replace(/\/+$/, "").replace(/\/api$/, "")

export interface AuthorizeOptions {
  clientId: string
  redirectUri: string
  state: string
  /** Pkce.challenge. */
  challenge: string
  /** Slack user scopes ("chat:write"…) or Campflare presets ("full"); sent comma-separated as user_scope. */
  userScopes: readonly string[]
}

/** Where the browser goes to sign in: `<server>/oauth/v2/authorize?…`. */
export function authorizeUrl(server: string, opts: AuthorizeOptions): string {
  const url = new URL(`${serverRoot(server)}/oauth/v2/authorize`)
  url.search = new URLSearchParams({
    client_id: opts.clientId,
    redirect_uri: opts.redirectUri,
    user_scope: opts.userScopes.join(","),
    state: opts.state,
    code_challenge: opts.challenge,
    code_challenge_method: "S256",
  }).toString()
  return url.toString()
}

/**
 * The code from the browser's return to redirect_uri, once its `state` is the
 * one this sign-in sent. Throws OAuthError: `state_mismatch` first (a callback
 * that isn't ours says nothing to trust), then the browser's `error`, or
 * `missing_code`.
 */
export function callbackCode(query: URLSearchParams, state: string): string {
  if (query.get("state") !== state)
    throw new OAuthError("state_mismatch", "sign-in failed: the browser came back with the wrong state")
  const error = query.get("error")
  if (error) throw new OAuthError(error)
  const code = query.get("code")
  if (!code) throw new OAuthError("missing_code")
  return code
}

export interface ExchangeOptions {
  clientId: string
  code: string
  /** The same redirect_uri the authorize URL had. */
  redirectUri: string
  /** Pkce.verifier. */
  verifier: string
  fetch?: Fetch
}

/** Redeems the code at oauth.v2.access. Throws ApiError (invalid_code, bad_redirect_uri…) as any call does. */
export function exchangeCode(server: string, opts: ExchangeOptions): Promise<OAuthV2Access> {
  return createClient({ url: server, fetch: opts.fetch }).call<OAuthV2Access>("oauth.v2.access", {
    client_id: opts.clientId,
    code: opts.code,
    redirect_uri: opts.redirectUri,
    code_verifier: opts.verifier,
  })
}
