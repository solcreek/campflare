import { createHash, randomBytes } from "node:crypto"
import { LogLevel, WebClient, type OAuthV2AccessArguments } from "@slack/web-api"
import { describe, expect, inject, it } from "vitest"
import { approveInBrowser } from "./browser.ts"

// Slack's OAuth v2 sign-in over real HTTP, redeemed by the official
// @slack/web-api's oauth.v2.access, as a public client with PKCE.

const base = inject("baseUrl")
const slackApiUrl = `${base}/api/`
const client = (token?: string) =>
  new WebClient(token, { slackApiUrl, logLevel: LogLevel.ERROR, retryConfig: { retries: 0 } })

describe("OAuth v2 with @slack/web-api", () => {
  it("signs a person in through the browser and redeems the code for an xoxp token", async () => {
    const boot = (await client().apiCall("campflare.bootstrap", {
      secret: "conformance",
      team_name: `OAuth ${Date.now()}`,
      user_name: "owner",
    })) as unknown as { token: string; user: { id: string }; team: { id: string } }

    const verifier = randomBytes(32).toString("base64url")
    const challenge = createHash("sha256").update(verifier).digest("base64url")
    const redirectUri = "http://127.0.0.1:53682/callback"
    const authorize = new URL("/oauth/v2/authorize", base)
    authorize.search = new URLSearchParams({
      client_id: "campflare-cli",
      redirect_uri: redirectUri,
      user_scope: "chat:write,channels:read",
      state: "xyz",
      code_challenge: challenge,
      code_challenge_method: "S256",
    }).toString()
    const back = await approveInBrowser(authorize.toString(), boot.token)
    expect(`${back.origin}${back.pathname}`).toBe(redirectUri)
    expect(back.searchParams.get("state")).toBe("xyz")

    // A public client has no secret; the PKCE verifier proves it started the flow.
    const args = {
      client_id: "campflare-cli",
      client_secret: "",
      code: back.searchParams.get("code")!,
      redirect_uri: redirectUri,
      code_verifier: verifier,
    } as OAuthV2AccessArguments
    const res = await client().oauth.v2.access(args)
    expect(res).toMatchObject({
      ok: true,
      authed_user: { id: boot.user.id, scope: "chat:write,channels:read", token_type: "user" },
      team: { id: boot.team.id },
      is_enterprise_install: false,
    })
    const me = await client(res.authed_user!.access_token).auth.test()
    expect(me.user_id).toBe(boot.user.id)

    // The code is spent.
    await expect(client().oauth.v2.access(args)).rejects.toMatchObject({ data: { error: "invalid_code" } })
  })
})
