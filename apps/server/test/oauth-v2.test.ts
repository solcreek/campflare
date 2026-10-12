import { SELF } from "cloudflare:test"
import { env } from "cloudflare:workers"
import { describe, expect, it } from "vitest"
import { browser, next, pkce } from "./browser"
import { setAuthOverrides } from "../src/auth/routes"
import { OAUTH_TOKENS_PER_CLIENT } from "../src/methods/oauth"
import { call, ok, ORIGIN, workspace } from "./helpers"

// Slack's OAuth v2 for apps signing a person in: /oauth/v2/authorize in the
// browser, then oauth.v2.access for a user token (xoxp-).

const CLIENT_ID = "campflare-cli"
const CLIENT_NAMES: Record<string, string> = {
  "campflare-cli": "Campflare CLI",
  "campflare-desktop": "Campflare for desktop",
  "https://agent.example.com/oauth/client.json": "Agente Ñandú 代理",
}
const redirectUri = (port = 49_152) => `http://127.0.0.1:${port}/callback`

/** Opens /oauth/v2/authorize and follows Better Auth to the sign-in page. */
async function start(opts: { clientId?: string; redirect?: string; userScope?: string } = {}) {
  const { verifier, challenge } = await pkce()
  const redirect = opts.redirect ?? redirectUri()
  const b = browser()
  const url = new URL("/oauth/v2/authorize", ORIGIN)
  for (const [k, v] of Object.entries({
    client_id: opts.clientId ?? CLIENT_ID,
    redirect_uri: redirect,
    state: "état-状態-123",
    user_scope: opts.userScope ?? "chat:write,channels:read",
    code_challenge: challenge,
    code_challenge_method: "S256",
  })) {
    url.searchParams.set(k, v)
  }
  const toProvider = await b.go(url.toString())
  expect(toProvider.status).toBe(302)
  const step = await next(await b.go(await next(toProvider)))
  return { b, verifier, redirect, step }
}

/** The whole browser part: sign in with a token, allow, and land on the redirect URI. */
async function authorize(userToken: string, opts: Parameters<typeof start>[0] = {}) {
  const { b, verifier, redirect, step } = await start(opts)
  expect(new URL(step, ORIGIN).pathname).toBe("/login")
  const signIn = await b.go("/login", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ token: userToken, oauth_query: new URL(step, ORIGIN).search.slice(1) }),
  })
  const afterSignIn = await next(signIn)
  let callback: URL
  if (new URL(afterSignIn, ORIGIN).pathname === "/consent") {
    const page = await (await b.go(afterSignIn)).text()
    const name = CLIENT_NAMES[opts.clientId ?? CLIENT_ID]
    if (!page.includes(`Allow ${name}?`) || !page.includes("chat:write")) {
      throw new Error(`unexpected consent page: ${page.slice(0, 300)}`)
    }
    const decided = await b.go("/consent", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ accept: "true", oauth_query: new URL(afterSignIn, ORIGIN).search.slice(1) }),
    })
    callback = new URL(await next(decided))
  } else {
    callback = new URL(afterSignIn)
  }
  expect(`${callback.origin}${callback.pathname}`).toBe(redirect)
  expect(callback.searchParams.get("state")).toBe("état-状態-123")
  const code = callback.searchParams.get("code")!
  expect(code).toBeTruthy()
  return { code, verifier, redirect, b }
}

type Access = {
  app_id: string
  authed_user: { id: string; scope: string; access_token: string; token_type: string }
  team: { id: string; name: string }
  enterprise: null
  is_enterprise_install: boolean
}

const access = (args: Record<string, string>) => call<Access>("oauth.v2.access", { client_id: CLIENT_ID, ...args })

/** A whole sign-in with a client: the person's xoxp token for it. */
async function signIn(userToken: string, clientId = CLIENT_ID): Promise<string> {
  const a = await authorize(userToken, { clientId })
  const res = await access({ client_id: clientId, code: a.code, code_verifier: a.verifier, redirect_uri: a.redirect })
  if (!res.ok) throw new Error(`oauth.v2.access failed: ${res.error}`)
  return res.authed_user.access_token
}

const labels = async (token: string) =>
  (await ok<{ tokens: { label: string }[] }>("campflare.tokens.list", {}, token)).tokens.map((t) => t.label)

describe("OAuth v2 sign-in for a user token", () => {
  it("signs a person in through the browser and hands the app an xoxp token", async () => {
    const w = await workspace()
    const bob = await w.addUser("bob")
    const { code, verifier, redirect } = await authorize(bob.token)
    const res = await access({ code, code_verifier: verifier, redirect_uri: redirect, client_secret: "" })
    expect(res).toMatchObject({
      ok: true,
      app_id: CLIENT_ID,
      authed_user: { id: bob.id, scope: "chat:write,channels:read", token_type: "user" },
      team: { id: w.teamId },
      enterprise: null,
      is_enterprise_install: false,
    })
    expect(res).not.toHaveProperty("access_token") // no bot token: Slack sends it only for bot scopes
    const token = res.authed_user.access_token
    expect(token).toMatch(/^xoxp-/)

    const me = await ok<{ user_id: string }>("auth.test", {}, token)
    expect(me.user_id).toBe(bob.id)
    // Stored hashed and labelled, like any token; listed among the person's tokens.
    const list = await ok<{ tokens: { label: string }[] }>("campflare.tokens.list", {}, token)
    expect(list.tokens.map((t) => t.label)).toContain("OAuth: Campflare CLI")
    const stored = await env.DB.prepare("SELECT COUNT(*) AS n FROM tokens WHERE hash = ?")
      .bind(token)
      .first<{ n: number }>()
    expect(stored!.n).toBe(0)
  })

  it("matches loopback redirect URIs on any port, and remembers consent", async () => {
    const w = await workspace()
    const first = await authorize(w.owner.token, { redirect: redirectUri(50_001) })
    expect((await access({ code: first.code, code_verifier: first.verifier, redirect_uri: first.redirect })).ok).toBe(
      true,
    )
    // Signed in already (the session cookie) and consented: straight back with a code.
    const { b } = first
    const { verifier, challenge } = await pkce()
    const again = new URL("/oauth/v2/authorize", ORIGIN)
    again.search = new URLSearchParams({
      client_id: CLIENT_ID,
      redirect_uri: redirectUri(61_234),
      user_scope: "chat:write",
      code_challenge: challenge,
      code_challenge_method: "S256",
    }).toString()
    const callback = new URL(await next(await b.go(await next(await b.go(again.toString())))))
    expect(callback.port).toBe("61234")
    const res = await access({
      code: callback.searchParams.get("code")!,
      code_verifier: verifier,
      redirect_uri: redirectUri(61_234),
    })
    expect(res.authed_user.scope).toBe("chat:write")
  })

  it("refuses a wrong PKCE verifier, a reused code and an expired one", async () => {
    const w = await workspace()
    const a = await authorize(w.owner.token)
    const wrong = (await pkce()).verifier
    expect(await access({ code: a.code, code_verifier: wrong, redirect_uri: a.redirect })).toMatchObject({
      ok: false,
      error: "invalid_code",
    })
    // The failed try spent the code, as a stolen code's use should.
    expect((await access({ code: a.code, code_verifier: a.verifier, redirect_uri: a.redirect })).error).toBe(
      "invalid_code",
    )

    const c = await authorize(w.owner.token)
    expect((await access({ code: c.code, code_verifier: c.verifier, redirect_uri: c.redirect })).ok).toBe(true)
    expect((await access({ code: c.code, code_verifier: c.verifier, redirect_uri: c.redirect })).error).toBe(
      "invalid_code",
    )

    const d = await authorize(w.owner.token)
    await env.DB.prepare(`UPDATE "verification" SET "expiresAt" = '2000-01-01T00:00:00.000Z'`).run()
    expect((await access({ code: d.code, code_verifier: d.verifier, redirect_uri: d.redirect })).error).toBe(
      "invalid_code",
    )
    expect((await access({ code: "made-up", code_verifier: d.verifier })).error).toBe("invalid_code")
  })

  it("refuses a redirect URI other than the one authorized", async () => {
    const w = await workspace()
    const a = await authorize(w.owner.token)
    const res = await access({ code: a.code, code_verifier: a.verifier, redirect_uri: redirectUri(50_999) })
    expect(res.error).toBe("bad_redirect_uri")
  })

  it("refuses an unknown client and a redirect URI the client didn't register", async () => {
    const unknown = await start({ clientId: "no-such-client" })
    expect(unknown.step).toContain("error=invalid_client")
    const elsewhere = await start({ redirect: "https://attacker.example/callback" })
    expect(elsewhere.step).toContain("error=invalid_redirect")
    expect(elsewhere.step).not.toContain("attacker.example")

    const w = await workspace()
    const a = await authorize(w.owner.token)
    expect(
      (await access({ client_id: "no-such-client", code: a.code, code_verifier: a.verifier, redirect_uri: a.redirect }))
        .error,
    ).toBe("invalid_client_id")
    // Another real client can't redeem this client's code.
    const b = await authorize(w.owner.token)
    expect(
      (
        await access({
          client_id: "campflare-desktop",
          code: b.code,
          code_verifier: b.verifier,
          redirect_uri: b.redirect,
        })
      ).error,
    ).toBe("invalid_client_id")
  })

  it("takes client credentials by HTTP Basic, as Slack does", async () => {
    const w = await workspace()
    const a = await authorize(w.owner.token)
    const res = await SELF.fetch(`${ORIGIN}/api/oauth.v2.access`, {
      method: "POST",
      headers: { authorization: `Basic ${btoa(`${CLIENT_ID}:`)}` },
      body: new URLSearchParams({ code: a.code, code_verifier: a.verifier, redirect_uri: a.redirect }),
    })
    expect(await res.json()).toMatchObject({ ok: true, authed_user: { id: w.owner.id } })
    const garbled = await SELF.fetch(`${ORIGIN}/api/oauth.v2.access`, {
      method: "POST",
      headers: { authorization: "Basic %%%" },
      body: new URLSearchParams({ code: "x" }),
    })
    expect(await garbled.json()).toMatchObject({ ok: false, error: "invalid_client_id" })
  })

  it("redirects to the origin the browser used, behind a TLS-terminating proxy", async () => {
    const res = await SELF.fetch(
      "http://campflare.test/oauth/v2/authorize?client_id=campflare-cli&user_scope=chat:write",
      {
        headers: { "x-forwarded-proto": "https" },
        redirect: "manual",
      },
    )
    expect(res.status).toBe(302)
    expect(res.headers.get("location")).toMatch(/^https:\/\/campflare\.test\/auth\/oauth2\/authorize\?/)
  })

  it("checks its own arguments", async () => {
    expect((await call("oauth.v2.access", { code: "x" })).error).toBe("invalid_client_id")
    expect((await access({})).error).toBe("invalid_code")
    expect((await access({ grant_type: "refresh_token", refresh_token: "x" })).error).toBe("invalid_grant_type")
    // Bot scopes install an app; this flow only signs a person in.
    const res = await SELF.fetch(`${ORIGIN}/oauth/v2/authorize?client_id=${CLIENT_ID}&scope=chat:write`)
    expect(res.status).toBe(400)
    expect(await res.text()).toContain("user_scope")
  })

  it("refuses scopes it doesn't know", async () => {
    const { step } = await start({ userScope: "chat:write,admin.everything" })
    const back = new URL(step)
    expect(back.searchParams.get("error")).toBe("invalid_scope")
    expect(back.searchParams.get("state")).toBe("état-状態-123")
  })

  it("leaves no Better Auth tokens behind from the code exchange, and keeps the consent", async () => {
    // A client allowed to refresh, asking for offline_access, gets a refresh token from Better Auth too.
    const agent = "https://agent.example.com/oauth/client.json"
    setAuthOverrides({
      fetchClientMetadataResource: async () =>
        Response.json({
          client_id: agent,
          client_name: "Agente Ñandú 代理",
          redirect_uris: [redirectUri()],
          grant_types: ["authorization_code", "refresh_token"],
          response_types: ["code"],
          token_endpoint_auth_method: "none",
        }),
    })
    try {
      const w = await workspace()
      const count = async (table: string) =>
        (await env.DB.prepare(`SELECT COUNT(*) AS n FROM "${table}"`).first<{ n: number }>())!.n
      const before = { access: await count("oauthAccessToken"), refresh: await count("oauthRefreshToken") }
      for (const clientId of [CLIENT_ID, agent]) {
        const a = await authorize(w.owner.token, { clientId, userScope: "chat:write,offline_access" })
        const res = await access({
          client_id: clientId,
          code: a.code,
          code_verifier: a.verifier,
          redirect_uri: a.redirect,
        })
        expect(res.ok).toBe(true)
      }
      expect(await count("oauthAccessToken")).toBe(before.access)
      expect(await count("oauthRefreshToken")).toBe(before.refresh)
      expect(await labels(w.owner.token)).toContain("OAuth: Agente Ñandú 代理")
      const consents = await env.DB.prepare(
        `SELECT COUNT(*) AS n FROM "oauthConsent" WHERE "clientId" IN (?, ?)
         AND "userId" = (SELECT "userId" FROM "account" WHERE "providerId" = 'campflare' AND "accountId" = ?)`,
      )
        .bind(CLIENT_ID, agent, w.owner.id)
        .first<{ n: number }>()
      expect(consents!.n).toBe(2)
    } finally {
      setAuthOverrides({})
    }
  })

  it("keeps the newest few tokens per person and client when they sign in again", async () => {
    const w = await workspace()
    const bob = await w.addUser("bob")
    const manual = (
      await ok<{ token: string }>("campflare.tokens.create", { label: "OAuth: Campflare CLI" }, bob.token)
    ).token
    const desktop = await signIn(bob.token, "campflare-desktop")
    const owners = await signIn(w.owner.token)

    const cli: string[] = []
    for (let i = 0; i < OAUTH_TOKENS_PER_CLIENT + 2; i++) cli.push(await signIn(bob.token))

    // The oldest two are revoked; the newest stay live, as on several computers at once.
    for (const old of cli.slice(0, 2)) expect((await call("auth.test", {}, old)).error).toBe("token_revoked")
    for (const kept of cli.slice(2)) expect((await call("auth.test", {}, kept)).ok).toBe(true)
    const live = await labels(bob.token)
    // The manually created token with the same label isn't one of them, nor is another client's.
    expect(live.filter((l) => l === "OAuth: Campflare CLI")).toHaveLength(OAUTH_TOKENS_PER_CLIENT + 1)
    expect(live.filter((l) => l === "OAuth: Campflare for desktop")).toHaveLength(1)
    for (const other of [manual, desktop, owners]) expect((await call("auth.test", {}, other)).ok).toBe(true)
  })

  it("lets auth.revoke end a token it issued", async () => {
    const w = await workspace()
    const token = await signIn(w.owner.token)
    expect(await ok("auth.revoke", {}, token)).toMatchObject({ revoked: true })
    expect((await call("auth.test", {}, token)).error).toBe("token_revoked")
    expect(await labels(w.owner.token)).not.toContain("OAuth: Campflare CLI")
    // Signing in again works as the first time did.
    expect((await call("auth.test", {}, await signIn(w.owner.token))).ok).toBe(true)
  })

  it("issues no token for a person deactivated after consenting", async () => {
    const w = await workspace()
    const bob = await w.addUser("bob")
    const a = await authorize(bob.token)
    await ok("campflare.users.deactivate", { user: bob.id }, w.owner.token)
    expect((await access({ code: a.code, code_verifier: a.verifier, redirect_uri: a.redirect })).error).toBe(
      "account_inactive",
    )
  })
})
