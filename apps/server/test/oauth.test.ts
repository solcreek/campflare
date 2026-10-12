import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client"
import { SELF } from "cloudflare:test"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { setAuthOverrides } from "../src/auth/routes"
import { ok, workspace } from "./helpers"

const ORIGIN = "https://campflare.test"
const CLIENT_ID = "https://agent.example.com/oauth/client.json"
const REDIRECT_URI = "http://127.0.0.1:33418/callback"

/** The client's metadata document (CIMD), served without the network. */
const clientDocument = {
  client_id: CLIENT_ID,
  client_name: "Example Agent",
  client_uri: "https://agent.example.com",
  redirect_uris: [REDIRECT_URI],
  grant_types: ["authorization_code", "refresh_token"],
  response_types: ["code"],
  token_endpoint_auth_method: "none",
}

beforeEach(() => {
  setAuthOverrides({
    fetchClientMetadataResource: async (input) => {
      const url = String(input instanceof Request ? input.url : input)
      if (url !== CLIENT_ID) return new Response("not found", { status: 404 })
      return Response.json(clientDocument, { headers: { "cache-control": "max-age=300" } })
    },
  })
})
afterEach(() => setAuthOverrides({}))

const b64url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "")

async function pkce() {
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)))
  const challenge = b64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))))
  return { verifier, challenge }
}

/** A browser of sorts: follows nothing on its own, but keeps cookies. */
function browser() {
  const jar = new Map<string, string>()
  return {
    async go(url: string, init: RequestInit = {}) {
      const headers = new Headers(init.headers)
      if (jar.size) headers.set("cookie", [...jar].map(([k, v]) => `${k}=${v}`).join("; "))
      headers.set("origin", ORIGIN)
      headers.set("sec-fetch-mode", "navigate")
      headers.set("accept", "text/html")
      const res = await SELF.fetch(new URL(url, ORIGIN).toString(), { ...init, headers, redirect: "manual" })
      for (const cookie of res.headers.getSetCookie()) {
        const [pair] = cookie.split(";")
        const eq = pair!.indexOf("=")
        jar.set(pair!.slice(0, eq), pair!.slice(eq + 1))
      }
      return res
    },
  }
}

/** Where a response sends the browser next: a redirect, or Better Auth's { url } JSON. */
async function next(res: Response): Promise<string> {
  const location = res.headers.get("location")
  if (location) return location
  const body = (await res.json().catch(() => ({}))) as { url?: string; redirect?: boolean }
  if (!body.url) throw new Error(`no next step from ${res.status}: ${JSON.stringify(body)}`)
  return body.url
}

type Tokens = { access_token: string; refresh_token?: string; token_type: string }

/** Runs the browser part of the authorization-code flow, up to the redirect back to the client. */
async function consentFlow(userToken: string, { deny = false } = {}) {
  const { verifier, challenge } = await pkce()
  const b = browser()
  const authorizeUrl = new URL("/auth/oauth2/authorize", ORIGIN)
  for (const [k, v] of Object.entries({
    response_type: "code",
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state: "state-123",
    resource: `${ORIGIN}/mcp`,
    scope: "openid offline_access",
  })) {
    authorizeUrl.searchParams.set(k, v)
  }
  const toLogin = await next(await b.go(authorizeUrl.toString()))
  expect(new URL(toLogin, ORIGIN).pathname).toBe("/login")
  const login = await b.go(toLogin)
  expect(login.status).toBe(200)
  expect(await login.text()).toContain("Sign in to Campflare")

  const signIn = await b.go("/login", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ token: userToken, oauth_query: new URL(toLogin, ORIGIN).search.slice(1) }),
  })
  const afterSignIn = await next(signIn)
  let callback: URL
  const askedConsent = new URL(afterSignIn, ORIGIN).pathname === "/consent"
  if (askedConsent) {
    const consent = await (await b.go(afterSignIn)).text()
    if (!consent.includes("Allow Example Agent?")) throw new Error(`unexpected consent page: ${consent.slice(0, 200)}`)
    const decided = await b.go("/consent", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        accept: deny ? "false" : "true",
        oauth_query: new URL(afterSignIn, ORIGIN).search.slice(1),
      }),
    })
    callback = new URL(await next(decided))
  } else {
    // Consent already given to this client: straight back to it.
    callback = new URL(afterSignIn)
  }
  expect(`${callback.origin}${callback.pathname}`).toBe(REDIRECT_URI)
  expect(callback.searchParams.get("state")).toBe("state-123")
  return { callback, verifier, askedConsent }
}

/** The whole flow: consent, then the code exchanged (with the PKCE verifier) for tokens. */
async function authorize(userToken: string): Promise<{ tokens: Tokens; askedConsent: boolean }> {
  const { callback, verifier, askedConsent } = await consentFlow(userToken)
  const code = callback.searchParams.get("code")!
  const tokenRes = await SELF.fetch(`${ORIGIN}/auth/oauth2/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: REDIRECT_URI,
      client_id: CLIENT_ID,
      code_verifier: verifier,
      resource: `${ORIGIN}/mcp`,
    }),
  })
  const tokens = (await tokenRes.json()) as Partial<Tokens> & { error?: string }
  if (!tokens.access_token) throw new Error(`token exchange failed: ${JSON.stringify(tokens)}`)
  return { tokens: tokens as Tokens, askedConsent }
}

async function mcpAs(accessToken: string) {
  const client = new Client(
    { name: "oauth-test", version: "1" },
    { versionNegotiation: { mode: { pin: "2026-07-28" } } },
  )
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${ORIGIN}/mcp`), {
      fetch: (input, init) => SELF.fetch(new Request(input, init)),
      requestInit: { headers: { authorization: `Bearer ${accessToken}` } },
    }),
  )
  return client
}

describe("OAuth for MCP clients", () => {
  it("advertises its authorization server from a 401 (RFC 9728, RFC 8414)", async () => {
    const res = await SELF.fetch(`${ORIGIN}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    })
    expect(res.status).toBe(401)
    const challenge = res.headers.get("www-authenticate")!
    const prmUrl = challenge.match(/resource_metadata="([^"]+)"/)?.[1]
    expect(prmUrl).toBe(`${ORIGIN}/.well-known/oauth-protected-resource/mcp`)

    const prm = (await (await SELF.fetch(prmUrl!)).json()) as { resource: string; authorization_servers: string[] }
    expect(prm.resource).toBe(`${ORIGIN}/mcp`)
    expect(prm.authorization_servers).toEqual([`${ORIGIN}/auth`])

    const as = (await (await SELF.fetch(`${ORIGIN}/.well-known/oauth-authorization-server/auth`)).json()) as Record<
      string,
      unknown
    >
    expect(as).toMatchObject({
      issuer: `${ORIGIN}/auth`,
      authorization_endpoint: `${ORIGIN}/auth/oauth2/authorize`,
      token_endpoint: `${ORIGIN}/auth/oauth2/token`,
      code_challenge_methods_supported: ["S256"],
      client_id_metadata_document_supported: true,
    })
    // Dynamic client registration is off: MCP 2026-07-28 identifies clients by metadata document.
    expect(as.registration_endpoint).toBeUndefined()
  })

  it("signs a person in with their Campflare token, asks consent, and issues a token for /mcp", async () => {
    const w = await workspace()
    const bob = await w.addUser("bob")
    const { tokens, askedConsent } = await authorize(bob.token)
    expect(askedConsent).toBe(true)
    expect(tokens.token_type).toMatch(/bearer/i)
    const payload = JSON.parse(
      atob(tokens.access_token.split(".")[1]!.replace(/-/g, "+").replace(/_/g, "/")),
    ) as Record<string, unknown>
    expect(payload).toMatchObject({ iss: `${ORIGIN}/auth`, aud: expect.arrayContaining([`${ORIGIN}/mcp`]) })

    const client = await mcpAs(tokens.access_token)
    const me = (await client.callTool({ name: "whoami", arguments: {} })) as {
      structuredContent: Record<string, unknown>
    }
    expect(me.structuredContent).toMatchObject({ user: "@bob", user_id: bob.id, workspace_id: w.teamId })
    const sent = (await client.callTool({
      name: "send_message",
      arguments: { conversation: "#general", text: "via OAuth" },
    })) as {
      structuredContent: { ts: string }
    }
    const history = await ok<{ messages: { ts: string; user: string }[] }>(
      "conversations.history",
      { channel: w.general },
      w.owner.token,
    )
    expect(history.messages.find((m) => m.ts === sent.structuredContent.ts)?.user).toBe(bob.id)
    await client.close()

    // Signing in again links to the same person, and remembered consent isn't asked again.
    const again = await authorize(bob.token)
    expect(again.askedConsent).toBe(false)
    const second = await mcpAs(again.tokens.access_token)
    expect(
      ((await second.callTool({ name: "whoami", arguments: {} })) as { structuredContent: Record<string, unknown> })
        .structuredContent,
    ).toMatchObject({ user_id: bob.id })
    await second.close()
  })

  it("lets the person deny", async () => {
    const w = await workspace()
    const { callback } = await consentFlow(w.owner.token, { deny: true })
    expect(callback.searchParams.get("error")).toBe("access_denied")
    expect(callback.searchParams.get("code")).toBeNull()
  })

  it("refuses bad tokens at sign-in and at /mcp", async () => {
    const w = await workspace()
    const app = await w.addApp("Robot")
    const signIn = (token: string) =>
      SELF.fetch(`${ORIGIN}/auth/sign-in/campflare-token`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: ORIGIN },
        body: JSON.stringify({ token }),
      })
    expect((await signIn("xoxp-nope")).status).toBe(401)
    expect((await signIn(app.botToken)).status).toBe(401)
    expect((await signIn(w.owner.token)).status).toBe(200)

    const call = (token: string) =>
      SELF.fetch(`${ORIGIN}/mcp`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      })
    expect((await call("not.a.jwt")).status).toBe(401)
    // Signed by someone else, or for another audience: refused all the same.
    const forged = `${btoa(JSON.stringify({ alg: "none" }))}.${btoa(JSON.stringify({ sub: "x", aud: `${ORIGIN}/mcp` }))}.`
    expect((await call(forged)).status).toBe(401)
  })

  it("stops working when the person is deactivated", async () => {
    const w = await workspace()
    const bob = await w.addUser("bob")
    const { tokens } = await authorize(bob.token)
    await ok("campflare.users.deactivate", { user: bob.id }, w.owner.token)
    const res = await SELF.fetch(`${ORIGIN}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${tokens.access_token}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    })
    expect(res.status).toBe(401)
  })

  it("shows sign-in errors on the page instead of failing the flow", async () => {
    const res = await browser().go("/login", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token: "xoxp-wrong", oauth_query: "client_id=x" }),
    })
    expect(res.status).toBe(200)
    const html = await res.text()
    expect(html).toContain("That token didn&#39;t work")
    expect(html).toContain('value="client_id=x"') // the flow can carry on from the same page
    expect(res.headers.get("content-security-policy")).toContain("frame-ancestors 'none'")
  })

  it("refreshes access tokens", async () => {
    const w = await workspace()
    const { tokens } = await authorize(w.owner.token)
    expect(tokens.refresh_token).toEqual(expect.any(String))
    const res = await SELF.fetch(`${ORIGIN}/auth/oauth2/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: tokens.refresh_token!,
        client_id: CLIENT_ID,
        resource: `${ORIGIN}/mcp`,
      }),
    })
    const refreshed = (await res.json()) as Tokens
    expect(refreshed.access_token).toEqual(expect.any(String))
    const client = await mcpAs(refreshed.access_token)
    expect(
      ((await client.callTool({ name: "whoami", arguments: {} })) as { structuredContent: Record<string, unknown> })
        .structuredContent,
    ).toMatchObject({
      user_id: w.owner.id,
    })
    await client.close()
  })
})
