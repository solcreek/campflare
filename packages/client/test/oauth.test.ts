import { createHash } from "node:crypto"
import { describe, expect, it } from "vitest"
import {
  ApiError,
  authorizeUrl,
  callbackCode,
  createPkce,
  exchangeCode,
  type Fetch,
  OAuthError,
  randomState,
  serverRoot,
} from "../src/index"

describe("createPkce", () => {
  it("makes a fresh 43-character verifier and its S256 challenge", async () => {
    const a = await createPkce()
    const b = await createPkce()
    expect(a.verifier).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(a.verifier).not.toBe(b.verifier)
    // RFC 7636: BASE64URL(SHA256(ASCII(verifier))), no padding.
    expect(a.challenge).toBe(createHash("sha256").update(a.verifier).digest("base64url"))
  })
})

describe("randomState", () => {
  it("is URL-safe and different each time", () => {
    const s = randomState()
    expect(s).toMatch(/^[A-Za-z0-9_-]{22}$/)
    expect(randomState()).not.toBe(s)
  })
})

describe("serverRoot", () => {
  it("accepts the server with or without /api and slashes", () => {
    for (const url of ["https://x.test", "https://x.test/", "https://x.test/api", "https://x.test/api/"]) {
      expect(serverRoot(url)).toBe("https://x.test")
    }
  })
})

describe("authorizeUrl", () => {
  it("asks for user scopes with PKCE S256 and the app's redirect", () => {
    const url = new URL(
      authorizeUrl("https://x.test/api/", {
        clientId: "campflare-web",
        redirectUri: "http://localhost:4000/",
        state: "état-状態",
        challenge: "abc",
        userScopes: ["chat:write", "channels:read"],
      }),
    )
    expect(`${url.origin}${url.pathname}`).toBe("https://x.test/oauth/v2/authorize")
    expect(Object.fromEntries(url.searchParams)).toEqual({
      client_id: "campflare-web",
      redirect_uri: "http://localhost:4000/",
      user_scope: "chat:write,channels:read",
      state: "état-状態",
      code_challenge: "abc",
      code_challenge_method: "S256",
    })
  })
})

const q = (fields: Record<string, string>) => new URLSearchParams(fields)

function failure(fn: () => unknown): OAuthError {
  try {
    fn()
  } catch (err) {
    expect(err).toBeInstanceOf(OAuthError)
    return err as OAuthError
  }
  throw new Error("did not throw")
}

describe("callbackCode", () => {
  it("returns the code when the state is this sign-in's", () => {
    expect(callbackCode(q({ code: "c1", state: "s1" }), "s1")).toBe("c1")
  })

  it("refuses another sign-in's state before trusting anything else", () => {
    const err = failure(() => callbackCode(q({ error: "access_denied", state: "other" }), "s1"))
    expect(err.code).toBe("state_mismatch")
    expect(err.message).toContain("wrong state")
    expect(failure(() => callbackCode(q({ code: "c1" }), "s1")).code).toBe("state_mismatch")
  })

  it("reports the browser's error, or a missing code", () => {
    const denied = failure(() => callbackCode(q({ error: "access_denied", state: "s1" }), "s1"))
    expect(denied.code).toBe("access_denied")
    expect(denied.message).toBe("sign-in failed: access_denied")
    expect(failure(() => callbackCode(q({ state: "s1" }), "s1")).code).toBe("missing_code")
  })
})

describe("exchangeCode", () => {
  it("redeems the code at oauth.v2.access with the verifier", async () => {
    const seen: { url: string; body: string }[] = []
    const fetch: Fetch = async (input, init) => {
      seen.push({ url: String(input), body: String(init?.body) })
      return Response.json({
        ok: true,
        app_id: "campflare-web",
        authed_user: { id: "U1", scope: "chat:write", access_token: "xoxp-new", token_type: "user" },
        team: { id: "T1", name: "Équipe 東京" },
        enterprise: null,
        is_enterprise_install: false,
      })
    }
    const res = await exchangeCode("https://x.test", {
      clientId: "campflare-web",
      code: "c1",
      redirectUri: "http://localhost:4000/",
      verifier: "v1",
      fetch,
    })
    expect(res.authed_user.access_token).toBe("xoxp-new")
    expect(res.team.name).toBe("Équipe 東京")
    expect(seen[0]!.url).toBe("https://x.test/api/oauth.v2.access")
    expect(Object.fromEntries(new URLSearchParams(seen[0]!.body))).toEqual({
      client_id: "campflare-web",
      code: "c1",
      redirect_uri: "http://localhost:4000/",
      code_verifier: "v1",
    })
  })

  it("throws the server's error code", async () => {
    const err = await exchangeCode("https://x.test", {
      clientId: "campflare-web",
      code: "used",
      redirectUri: "http://localhost:4000/",
      verifier: "v1",
      fetch: async () => Response.json({ ok: false, error: "invalid_code" }),
    }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ApiError)
    expect((err as ApiError).code).toBe("invalid_code")
  })
})
