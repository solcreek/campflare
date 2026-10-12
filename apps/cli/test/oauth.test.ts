import { describe, expect, it } from "vitest"
import { approveInBrowser } from "../../../tests/conformance/browser"
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
