import { type ApiError, createClient, type Fetch } from "@campflare/client"
import { describe, expect, it } from "vitest"
import { approveInBrowser } from "../../../tests/conformance/browser"
import { revokeToken } from "../src/oauth"
import { baseUrl, loggedIn, memoryIo } from "./harness"

// `login --oauth` against a real server: the "browser" is a fetch that signs
// in and allows on the server's pages, then calls the CLI's loopback listener.

/** The person in front of the browser, signing in with an existing token of theirs. */
const person =
  (token: string, opts: { deny?: boolean; tamper?: (callback: URL) => void } = {}) =>
  async (url: string) => {
    const callback = await approveInBrowser(url, token, opts)
    opts.tamper?.(callback)
    const res = await fetch(callback)
    expect(res.status).toBe(200)
  }

async function ownerToken() {
  const owner = await loggedIn()
  return owner.config!.profiles.default!.token!
}

describe("login --oauth", () => {
  it("signs in through the browser, with PKCE and a loopback redirect, and saves the profile", async () => {
    const token = await ownerToken()
    let opened = ""
    const cli = memoryIo({
      openUrl: (url) => {
        opened = url
        return person(token)(url)
      },
    })
    expect(await cli.run("login", "--oauth", "--url", baseUrl, "--profile", "browser")).toBe(0)
    expect(cli.out).toMatch(/^Logged in to CLI .* as @owner \(profile browser\)/)
    expect(cli.err).toContain(opened) // printed, for a terminal without a browser

    const url = new URL(opened)
    expect(url.pathname).toBe("/oauth/v2/authorize")
    expect(url.searchParams.get("client_id")).toBe("campflare-cli")
    expect(url.searchParams.get("code_challenge_method")).toBe("S256")
    expect(url.searchParams.get("redirect_uri")).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/)

    const saved = cli.config!.profiles.browser!
    expect(saved.url).toBe(baseUrl)
    expect(saved.token).toMatch(/^xoxp-/)
    expect(saved.token).not.toBe(token)
    cli.clear()
    expect(await cli.run("whoami")).toBe(0)
    expect(cli.out).toMatch(/^@owner/)
    cli.clear()
    expect(await cli.run("token", "list")).toBe(0)
    expect(cli.out).toContain("OAuth: Campflare CLI")
  })

  it("reports a denial, a callback with the wrong state, and a cancelled sign-in", async () => {
    const token = await ownerToken()
    const denied = memoryIo({ openUrl: person(token, { deny: true }) })
    expect(await denied.run("login", "--oauth", "--url", baseUrl)).toBe(1)
    expect(denied.err).toContain("access_denied (you chose Deny)")
    expect(denied.config).toBeUndefined()

    const forged = memoryIo({ openUrl: person(token, { tamper: (c) => c.searchParams.set("state", "forged") }) })
    expect(await forged.run("login", "--oauth", "--url", `${baseUrl}/api`)).toBe(1)
    expect(forged.err).toContain("wrong state")

    const cancelled = memoryIo({
      openUrl: async () => {
        cancelled.interrupt()
      },
    })
    expect(await cancelled.run("login", "--oauth", "--url", baseUrl)).toBe(1)
    expect(cancelled.err).toContain("sign-in cancelled")
  })

  it("checks its options", async () => {
    const cli = memoryIo()
    expect(await cli.run("login", "--oauth")).toBe(2)
    expect(cli.err).toContain("needs --url")
    expect(await cli.run("login", "--oauth", "--token", "xoxp-x", "--url", baseUrl)).toBe(2)
    expect(await cli.run("login", "--oauth", "--url", baseUrl, "--port", "http")).toBe(2)
    expect(cli.err).toContain("--port is a port number")
  })
})

/** auth.test with a token: its user, or the error code. */
async function check(token: string) {
  try {
    return (await createClient({ url: baseUrl, token }).call<{ ok: boolean; user: string }>("auth.test")).user
  } catch (err) {
    return (err as ApiError).code
  }
}

describe("logout", () => {
  it("revokes a token from login --oauth and forgets the profile", async () => {
    const token = await ownerToken()
    const cli = memoryIo({ openUrl: person(token) })
    expect(await cli.run("login", "--oauth", "--url", baseUrl, "--profile", "browser")).toBe(0)
    const saved = cli.config!.profiles.browser!
    expect(saved.via).toBe("oauth")
    expect(await check(saved.token!)).toBe("owner")

    cli.clear()
    expect(await cli.run("logout")).toBe(0)
    expect(cli.out).toContain(`Revoked the token from signing in to ${baseUrl}`)
    expect(cli.out).toContain("profile browser forgotten")
    expect(cli.config!.profiles.browser).toBeUndefined()
    expect(cli.config!.current).toBeUndefined()
    expect(await check(saved.token!)).toBe("token_revoked")
    // The token the person signed in with in the browser is theirs, and untouched.
    expect(await check(token)).toBe("owner")

    cli.clear()
    expect(await cli.run("logout")).toBe(2)
    expect(cli.err).toContain("not logged in")
    expect(await cli.run("logout", "--profile", "nope")).toBe(2)
    expect(cli.err).toContain("no profile named nope")
  })

  it("forgets a token given by hand without revoking it", async () => {
    const owner = await loggedIn()
    const token = owner.config!.profiles.default!.token!
    const cli = memoryIo()
    expect(await cli.run("login", "--url", baseUrl, "--token", token, "--profile", "pasted")).toBe(0)
    expect(cli.config!.profiles.pasted!.via).toBe("token")
    cli.clear()
    expect(await cli.run("logout", "--profile", "pasted")).toBe(0)
    expect(cli.out).toContain("Not revoking the token")
    expect(cli.config!.profiles.pasted).toBeUndefined()
    expect(await check(token)).toBe("owner")
    // A profile from before `via` counts as given by hand.
    expect(owner.config!.profiles.default!.via).toBeUndefined()
    expect(await owner.run("logout")).toBe(0)
    expect(await check(token)).toBe("owner")
  })

  it("forgets the profile even when the server can't be reached", async () => {
    const cli = memoryIo()
    await cli.io.writeConfig(
      JSON.stringify({ current: "gone", profiles: { gone: { url: baseUrl, token: "xoxp-gone", via: "oauth" } } }),
    )
    cli.io.fetch = () => Promise.reject(new TypeError("fetch failed"))
    expect(await cli.run("logout")).toBe(0)
    expect(cli.err).toContain(`Couldn't revoke the token at ${baseUrl} (fetch failed)`)
    expect(cli.config!.profiles).toEqual({})

    // A server that never answers is given up on; one that refuses says why.
    let signal: AbortSignal | undefined
    const hanging: Fetch = (_input, init) => {
      signal = init?.signal ?? undefined
      return new Promise(() => {})
    }
    expect(await revokeToken({ ...cli.io, fetch: hanging }, baseUrl, "xoxp-gone", 20)).toEqual({
      revoked: false,
      reason: "no answer in 0.02 s",
    })
    expect(signal?.aborted).toBe(true)
    const refusing: Fetch = async () => Response.json({ ok: false, error: "ratelimited" })
    expect(await revokeToken({ ...cli.io, fetch: refusing }, baseUrl, "xoxp-gone")).toEqual({
      revoked: false,
      reason: "ratelimited",
    })
  })
})

describe("signing in again", () => {
  it("revokes the token from the previous login --oauth of that profile", async () => {
    const token = await ownerToken()
    const cli = memoryIo({ openUrl: person(token) })
    expect(await cli.run("login", "--oauth", "--url", baseUrl)).toBe(0)
    const first = cli.config!.profiles.default!.token!
    expect(await cli.run("login", "--oauth", "--url", baseUrl)).toBe(0)
    const second = cli.config!.profiles.default!.token!
    expect(second).not.toBe(first)
    expect(await check(first)).toBe("token_revoked")
    expect(await check(second)).toBe("owner")

    // Logging in with a pasted token over it revokes it too: nothing would know it any more.
    expect(await cli.run("login", "--url", baseUrl, "--token", token)).toBe(0)
    expect(await check(second)).toBe("token_revoked")
    // But a pasted token replaced by another login is left alone.
    expect(await cli.run("login", "--oauth", "--url", baseUrl)).toBe(0)
    expect(await check(token)).toBe("owner")
    expect(cli.err).not.toContain("Couldn't revoke")
    expect(cli.err).not.toContain("Didn't revoke")
  })

  it("counts the same server however its URL was typed", async () => {
    const token = await ownerToken()
    const cli = memoryIo({ openUrl: person(token) })
    expect(await cli.run("login", "--oauth", "--url", `${baseUrl}/api/`)).toBe(0)
    const first = cli.config!.profiles.default!.token!
    expect(await cli.run("login", "--oauth", "--url", baseUrl)).toBe(0)
    expect(await check(first)).toBe("token_revoked")
    expect(cli.err).not.toContain("Didn't revoke")
  })

  it("keeps the old token, and says how to end it, when signing in as someone else", async () => {
    const owner = await loggedIn()
    const olive = owner.config!.profiles.default!.token!
    expect(await owner.run("admin", "add-user", "bob", "--json")).toBe(0)
    const { token: bobToken } = JSON.parse(owner.out) as { token: string }

    const cli = memoryIo({ openUrl: person(olive) })
    expect(await cli.run("login", "--oauth", "--url", baseUrl)).toBe(0)
    const first = cli.config!.profiles.default!.token!
    cli.clear()
    expect(await cli.run("login", "--url", baseUrl, "--token", bobToken)).toBe(0)
    expect(await check(first)).toBe("owner")
    const lines = cli.err.trimEnd().split("\n")
    expect(lines).toHaveLength(1)
    expect(lines[0]).toMatch(/^Didn't revoke the previous token of this profile \(from login --oauth at /)
    expect(lines[0]).toContain("for @owner in CLI ")
    expect(lines[0]).toContain("this login is another user or workspace")
    expect(lines[0]).toContain("`campflare token revoke <id>`")
  })

  it("keeps the old token when signing in to another workspace or another server", async () => {
    const first = memoryIo({ openUrl: person(await ownerToken()) })
    expect(await first.run("login", "--oauth", "--url", baseUrl)).toBe(0)
    const old = first.config!.profiles.default!.token!

    // The same profile, signed in as the owner of another workspace.
    first.clear()
    const elsewhere = await ownerToken()
    expect(await first.run("login", "--url", baseUrl, "--token", elsewhere)).toBe(0)
    expect(await check(old)).toBe("owner")
    expect(first.err).toContain("this login is another user or workspace")

    // A profile from login --oauth at another server: that server isn't even asked.
    const cli = memoryIo()
    await cli.io.writeConfig(
      JSON.stringify({ profiles: { default: { url: "https://chat.example.invalid", token: old, via: "oauth" } } }),
    )
    let calls = 0
    cli.io.fetch = (input, init) => {
      calls++
      return fetch(input, init)
    }
    expect(await cli.run("login", "--url", baseUrl, "--token", elsewhere)).toBe(0)
    expect(calls).toBe(1) // auth.test of the new token, nothing more
    expect(await check(old)).toBe("owner")
    expect(cli.err).toContain("(from login --oauth at https://chat.example.invalid; this login is to another server)")
  })

  it("keeps the old token when the server can't say whose it was", async () => {
    const token = await ownerToken()
    const cli = memoryIo({ openUrl: person(token) })
    expect(await cli.run("login", "--oauth", "--url", baseUrl)).toBe(0)
    const first = cli.config!.profiles.default!.token!
    cli.io.fetch = (input, init) =>
      new Request(input, init).headers.get("authorization") === `Bearer ${first}`
        ? Promise.reject(new TypeError("fetch failed"))
        : fetch(input, init)
    expect(await cli.run("login", "--url", baseUrl, "--token", token)).toBe(0)
    expect(await check(first)).toBe("owner")
    expect(cli.err).toContain("couldn't ask whose it is: fetch failed")
  })

  it("forgets an old token the server already refuses without a word", async () => {
    const token = await ownerToken()
    const cli = memoryIo()
    await cli.io.writeConfig(
      JSON.stringify({ profiles: { default: { url: baseUrl, token: "xoxp-long-gone", via: "oauth" } } }),
    )
    expect(await cli.run("login", "--url", baseUrl, "--token", token)).toBe(0)
    expect(cli.err).toBe("")
  })
})
