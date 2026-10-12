import { act, cleanup, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { StrictMode } from "react"
import { afterEach, describe, expect, it } from "vitest"
import type { Fetch } from "@campflare/client"
import { App } from "@/app"
import { lastServer, rememberServer, servesApi, webOrigin } from "@/server-address"
import { browserStore } from "@/session"
import { fakeServer, FakeSocket, hello } from "./server"

// What the login screen's Server field starts with: the dev server, the last
// server signed in to, or the page's own origin when it serves the Web API.
// The token field never starts with anything.

afterEach(() => {
  FakeSocket.all = []
  localStorage.clear()
})

const field = async (name: string) => (await screen.findByLabelText(name)) as HTMLInputElement

describe("the login screen's server", () => {
  it("starts with the dev server in development, and never with a token", async () => {
    const server = fakeServer()
    render(
      <App
        store={browserStore()}
        connect={server.connect}
        fetch={server.api.fetch}
        devServer="http://localhost:4100"
      />,
    )
    expect((await field("Server")).value).toBe("http://localhost:4100")
    expect((await field("Token")).value).toBe("")
  })

  it("remembers the last server signed in to across sign-out, but not the token", async () => {
    const server = fakeServer()
    const store = browserStore()
    const user = userEvent.setup()
    render(<App store={store} connect={server.connect} fetch={server.api.fetch} />)
    // Nothing to go on yet: the field starts empty.
    expect((await field("Server")).value).toBe("")
    await user.type(await field("Server"), " https://café.example/ ")
    await user.type(await field("Token"), "xoxp-1")
    await user.click(screen.getByRole("button", { name: "Sign in with a token" }))
    await screen.findByRole("heading", { name: "general", level: 1 })
    act(() => hello())

    await user.click(screen.getByRole("button", { name: /Test Team/ }))
    await user.click(await screen.findByRole("menuitem", { name: "Sign out" }))
    expect((await field("Server")).value).toBe("https://café.example/")
    expect((await field("Token")).value).toBe("")
    expect(await store.load()).toBeNull()
    expect(JSON.stringify({ ...localStorage })).not.toContain("xoxp-1")

    // The next launch too, and the dev server wins over it.
    cleanup()
    render(<App store={store} connect={server.connect} fetch={server.api.fetch} />)
    expect((await field("Server")).value).toBe("https://café.example/")
    cleanup()
    render(<App store={store} connect={server.connect} devServer="http://localhost:4100" />)
    expect((await field("Server")).value).toBe("http://localhost:4100")
  })

  it("offers the page's own origin when it answers api.test, and only when there's nothing better", async () => {
    const server = fakeServer({ "api.test": () => ({}) })
    const origin = "https://チーム.example"
    const app = () => (
      <StrictMode>
        <App store={browserStore()} connect={server.connect} fetch={server.api.fetch} origin={origin} />
      </StrictMode>
    )
    render(app())
    await waitFor(async () => expect((await field("Server")).value).toBe(origin))
    const probes = () => server.api.calls.filter((c) => c.method === "api.test").length
    expect(probes()).toBeGreaterThan(0)

    // A page that isn't a server: the field stays empty.
    cleanup()
    delete server.api.handlers["api.test"]
    let before = probes()
    render(app())
    await waitFor(() => expect(probes()).toBeGreaterThan(before))
    expect((await field("Server")).value).toBe("")
    before = probes()

    // What the person typed before the answer came stays.
    cleanup()
    server.api.handlers["api.test"] = () => ({})
    let answer!: () => void
    const held = new Promise<void>((resolve) => (answer = resolve))
    const slow: Fetch = async (input, init) => {
      if (String(input).endsWith("/api.test")) await held
      return server.api.fetch(input, init)
    }
    const user = userEvent.setup()
    render(<App store={browserStore()} connect={server.connect} fetch={slow} origin={origin} />)
    await user.type(await field("Server"), "https://señal.example")
    await act(async () => answer())
    await waitFor(() => expect(probes()).toBeGreaterThan(before))
    expect((await field("Server")).value).toBe("https://señal.example")

    // A remembered server: no need to ask.
    cleanup()
    rememberServer("https://서버.example")
    const asked = probes()
    render(app())
    expect((await field("Server")).value).toBe("https://서버.example")
    expect(probes()).toBe(asked)
  })
})

describe("server-address", () => {
  it("survives storage that refuses to be read or written", () => {
    const broken = {
      getItem: () => {
        throw new Error("denied")
      },
      setItem: () => {
        throw new Error("quota")
      },
    }
    expect(lastServer(broken)).toBe("")
    expect(() => rememberServer("https://x.test", broken)).not.toThrow()
  })

  it("probes only a web page's http(s) origin", () => {
    const at = (origin: string) => ({ origin, protocol: new URL(origin).protocol })
    expect(webOrigin({ location: at("https://chat.example") })).toBe("https://chat.example")
    expect(webOrigin({ location: at("http://localhost:4100") })).toBe("http://localhost:4100")
    // The desktop shell's origin is its own, even where it's http (Windows).
    expect(webOrigin({ __TAURI__: {}, location: at("http://tauri.localhost") })).toBeUndefined()
    expect(webOrigin({ location: at("tauri://localhost") })).toBeUndefined()
    expect(webOrigin({})).toBeUndefined()
  })

  it("asks api.test once, without retrying", async () => {
    let asked = 0
    const busy = async () => {
      asked++
      return new Response("{}", { status: 429, headers: { "retry-after": "1" } })
    }
    expect(await servesApi("https://x.test", busy)).toBe(false)
    expect(asked).toBe(1)
    expect(await servesApi("https://x.test", () => Promise.reject(new TypeError("Failed to fetch")))).toBe(false)
    expect(await servesApi("https://x.test", async () => Response.json({ ok: true }))).toBe(true)
  })
})
