import { act, cleanup, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, describe, expect, it } from "vitest"
import { App } from "@/app"
import { lastServer, rememberServer } from "@/server-address"
import { browserStore } from "@/session"
import { fakeServer, FakeSocket, hello } from "./server"

// What the login screen's Server field starts with: the dev server, else the
// last server signed in to. The token field never starts with anything.

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
})
