import { createHash } from "node:crypto"
import { cleanup, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { StrictMode } from "react"
import { afterEach, describe, expect, it } from "vitest"
import { App } from "@/app"
import { browserStore, devSession, type Invoke } from "@/session"
import { desktopSignIn, platformSignIn, signInError, USER_SCOPES, webClient, webSignIn } from "@/sign-in"
import type { Handler } from "@campflare/core/testing"
import { fakeServer } from "./server"

// Signing in through the browser, on the fake Web API: the authorize URL the
// app leaves for, the browser's return (?code&state), and what goes wrong.

afterEach(() => {
  localStorage.clear()
  sessionStorage.clear()
})

const APP = "http://localhost:4000"
const at = (search = "", hash = "") => ({ origin: APP, pathname: "/", search, hash })

/** The app on the web, at `search`, leaving for wherever it navigates. */
function web(search = "", hash = "", handlers: Record<string, Handler> = {}) {
  const server = fakeServer(handlers)
  const left: string[] = []
  const replaced: string[] = []
  const store = browserStore()
  const location = at(search, hash)
  const signIn = webSignIn({
    location,
    storage: sessionStorage,
    navigate: (url) => left.push(url),
    replaceUrl: (url) => {
      replaced.push(url)
      location.search = new URL(url, APP).search
    },
    fetch: server.api.fetch,
  })
  return { server, left, replaced, store, signIn }
}

/** Starts a sign-in on the login screen and returns the authorize URL it left for. */
async function leaveForServer(server = "https://x.test") {
  const app = web()
  const user = userEvent.setup()
  render(<App store={app.store} connect={app.server.connect} fetch={app.server.api.fetch} signIn={app.signIn} />)
  const field = await screen.findByLabelText("Server")
  await user.clear(field)
  await user.type(field, server)
  await user.click(screen.getByRole("button", { name: "Sign in with your browser" }))
  await screen.findByRole("button", { name: "Waiting for your browser…" })
  cleanup()
  return new URL(app.left[0]!)
}

/** The browser coming back to the app with this query; renders the app there. */
function returnWith(query: Record<string, string>, hash = "", handlers: Record<string, Handler> = {}) {
  const app = web(`?${new URLSearchParams(query)}`, hash, handlers)
  // StrictMode, as main.tsx: effects run twice, and the address bar is clean by the second.
  render(
    <StrictMode>
      <App store={app.store} connect={app.server.connect} fetch={app.server.api.fetch} signIn={app.signIn} />
    </StrictMode>,
  )
  return app
}

describe("signing in through the browser", () => {
  it("leaves for the server's authorize page with PKCE, as campflare-web on loopback", async () => {
    const url = await leaveForServer("https://x.test/api/")
    expect(`${url.origin}${url.pathname}`).toBe("https://x.test/oauth/v2/authorize")
    const q = url.searchParams
    expect(q.get("client_id")).toBe("campflare-web")
    expect(q.get("redirect_uri")).toBe(`${APP}/`)
    expect(q.get("user_scope")).toBe(USER_SCOPES.join(","))
    expect(q.get("code_challenge_method")).toBe("S256")
    // The verifier waits in sessionStorage under the state, for the page the browser comes back to.
    const kept = JSON.parse(sessionStorage.getItem(`campflare.oauth.${q.get("state")}`)!)
    expect(kept).toMatchObject({ server: "https://x.test", clientId: "campflare-web", redirectUri: `${APP}/` })
    expect(createHash("sha256").update(kept.verifier).digest("base64url")).toBe(q.get("code_challenge"))
  })

  it("is a Client ID Metadata Document anywhere but loopback", () => {
    expect(webClient("http://127.0.0.1:4000")).toEqual({
      clientId: "campflare-web",
      redirectUri: "http://127.0.0.1:4000/",
    })
    expect(webClient("https://chat.example.com")).toEqual({
      clientId: "https://chat.example.com/oauth-client.json",
      redirectUri: "https://chat.example.com/",
    })
  })

  it("exchanges the code on return, keeps the session and cleans the address bar", async () => {
    const authorize = await leaveForServer()
    const state = authorize.searchParams.get("state")!
    // A session kept from before: the browser's answer wins over it.
    await browserStore().save({ url: "https://old.test", token: "xoxp-old" })
    let seen: Record<string, string> = {}
    const app = returnWith({ code: "code-1", state, iss: "https://x.test/auth" }, "#/CDEV", {
      "oauth.v2.access": (args) => {
        seen = args
        return {
          app_id: "campflare-web",
          authed_user: { id: "U1", scope: "chat:write", access_token: "xoxp-new", token_type: "user" },
          team: { id: "T1", name: "Test Team" },
        }
      },
    })
    expect(screen.getByText("Finishing sign-in…")).toBeTruthy()
    await screen.findByRole("heading", { name: "general", level: 1 })
    expect(seen).toMatchObject({ client_id: "campflare-web", code: "code-1", redirect_uri: `${APP}/` })
    expect(createHash("sha256").update(seen.code_verifier!).digest("base64url")).toBe(
      authorize.searchParams.get("code_challenge"),
    )
    expect(await app.store.load()).toEqual({ url: "https://x.test", token: "xoxp-new", via: "oauth" })
    expect(app.replaced).toEqual(["/#/CDEV"])
    // Spent: the same state can't be used twice.
    expect(sessionStorage.getItem(`campflare.oauth.${state}`)).toBeNull()
  })

  it("refuses a return it didn't start, a denial and a code the server won't take", async () => {
    returnWith({ code: "code-1", state: "forged" })
    expect((await screen.findByRole("alert")).textContent).toContain("didn't start here")
    expect(screen.getByRole("button", { name: "Sign in with your browser" })).toBeTruthy()
    cleanup()

    let state = (await leaveForServer()).searchParams.get("state")!
    returnWith({ error: "access_denied", state })
    expect((await screen.findByRole("alert")).textContent).toBe(
      "You chose Deny in the browser, so you're not signed in.",
    )
    cleanup()

    state = (await leaveForServer()).searchParams.get("state")!
    const app = web(`?code=old&state=${state}`)
    app.server.api.handlers["oauth.v2.access"] = () => new Error("invalid_code")
    render(<App store={app.store} connect={app.server.connect} signIn={app.signIn} />)
    expect((await screen.findByRole("alert")).textContent).toContain("expired or was already used")
    expect(await app.store.load()).toBeNull()
  })

  it("explains other failures", () => {
    expect(signInError(new TypeError("Failed to fetch"))).toBe("Couldn't reach the server")
    expect(signInError("timed out")).toBe("Sign-in didn't finish: timed out")
    expect(signInError(new Error("boom"))).toBe("Sign-in didn't finish: boom")
    const err = Object.assign(new Error("bad"), { code: "bad_redirect_uri" })
    expect(signInError(err)).toContain("bad") // not one of ours: its message
  })

  it("doesn't sign the dev server's people in over a return from the browser", () => {
    const dev = { url: "http://localhost:9", people: { alex: "xoxp-a" } }
    expect(devSession(dev, "?code=c&state=s")).toBeNull()
    expect(devSession(dev, "?as=none")).toBeNull()
    expect(devSession(dev, "")).toEqual({ url: dev.url, token: "xoxp-a" })
  })
})

/** The desktop shell: a loopback listener behind `oauth_*` commands, and the system browser. */
function shell() {
  const commands: string[] = []
  let answer: ((value: unknown) => void) | undefined
  let fail: ((reason: unknown) => void) | undefined
  const opened: string[] = []
  const invoke: Invoke = async (command) => {
    commands.push(command)
    if (command === "oauth_listen") return 51_234
    if (command === "oauth_wait") {
      return new Promise((ok, no) => {
        answer = ok
        fail = no
      })
    }
    if (command === "oauth_cancel") fail?.("cancelled")
    return null
  }
  return {
    commands,
    opened,
    invoke,
    /** The browser coming back to the listener with these fields (the state from the opened URL unless given). */
    back: (fields: Record<string, string | null>) =>
      answer?.({ state: new URL(opened.at(-1)!).searchParams.get("state"), ...fields }),
    openUrl: async (url: string) => {
      opened.push(url)
    },
  }
}

async function startOnDesktop(desk = shell()) {
  const server = fakeServer()
  const store = browserStore()
  const user = userEvent.setup()
  const signIn = desktopSignIn({ invoke: desk.invoke, openUrl: desk.openUrl, fetch: server.api.fetch })
  render(<App store={store} connect={server.connect} fetch={server.api.fetch} signIn={signIn} />)
  const field = await screen.findByLabelText("Server")
  await user.clear(field)
  await user.type(field, "https://x.test")
  await user.click(screen.getByRole("button", { name: "Sign in with your browser" }))
  await screen.findByRole("button", { name: "Waiting for your browser…" })
  return { desk, server, store, user }
}

describe("signing in through the browser on the desktop", () => {
  it("opens the system browser and takes the code at its loopback listener", async () => {
    const { desk, server, store } = await startOnDesktop()
    const url = new URL(desk.opened[0]!)
    expect(url.searchParams.get("client_id")).toBe("campflare-desktop")
    expect(url.searchParams.get("redirect_uri")).toBe("http://127.0.0.1:51234/callback")
    let seen: Record<string, string> = {}
    server.api.handlers["oauth.v2.access"] = (args) => {
      seen = args
      return { authed_user: { id: "U1", scope: "", access_token: "xoxp-desk", token_type: "user" }, team: {} }
    }
    desk.back({ code: "code-1", error: null })
    await screen.findByRole("heading", { name: "general", level: 1 })
    expect(seen).toMatchObject({ client_id: "campflare-desktop", redirect_uri: "http://127.0.0.1:51234/callback" })
    expect(await store.load()).toEqual({ url: "https://x.test", token: "xoxp-desk", via: "oauth" })
    expect(desk.commands).toEqual(["oauth_listen", "oauth_wait"])
  })

  it("reports a denial and a forged state, and cancels quietly", async () => {
    let { desk } = await startOnDesktop()
    desk.back({ error: "access_denied" })
    expect((await screen.findByRole("alert")).textContent).toContain("You chose Deny")
    cleanup()

    ;({ desk } = await startOnDesktop())
    desk.back({ code: "code-1", state: "forged" })
    expect((await screen.findByRole("alert")).textContent).toContain("didn't start here")
    cleanup()

    const started = await startOnDesktop()
    await started.user.click(screen.getByRole("button", { name: "Cancel" }))
    expect(started.desk.commands).toContain("oauth_cancel")
    expect(await screen.findByRole("button", { name: "Sign in with your browser" })).toBeTruthy()
    expect(screen.queryByRole("alert")).toBeNull()
  })

  it("stops listening when the browser can't be opened", async () => {
    const desk = shell()
    desk.openUrl = async () => {
      throw new Error("no browser")
    }
    await startOnDesktop(desk).catch(() => {})
    expect((await screen.findByRole("alert")).textContent).toBe("Sign-in didn't finish: no browser")
    expect(desk.commands).toContain("oauth_cancel")
  })

  it("is the desktop's flow when the shell is there", () => {
    const desk = shell()
    expect(
      platformSignIn({ __TAURI__: { core: { invoke: desk.invoke }, opener: { openUrl: desk.openUrl } } }).returning(),
    ).toBe(false)
    const browser = platformSignIn({})
    expect(typeof browser.returning()).toBe("boolean")
  })
})
