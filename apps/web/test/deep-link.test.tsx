import { act, render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, describe, expect, it } from "vitest"
import { App } from "@/app"
import { type DeepLinks, deepLinkHash, parseDeepLink, platformDeepLinks, serverOf } from "@/deep-link"
import { browserStore, type Session } from "@/session"
import { fakeServer, FakeSocket, hello } from "./server"

// campflare:// links, which the desktop shell hands to the app: what they
// mean (deep-link.ts), and what the app does with one on its own server, on
// another, and before it is signed in.

afterEach(() => {
  FakeSocket.all = []
  localStorage.clear()
  window.location.hash = ""
})

describe("parseDeepLink", () => {
  it("maps a permalink with the campflare scheme to the app's route on its server", () => {
    expect(parseDeepLink("campflare://chat.example.com/archives/C1/p1700000000000100")).toEqual({
      server: "chat.example.com",
      route: { channel: "C1", message: "1700000000.000100" },
      web: "https://chat.example.com/archives/C1/p1700000000000100",
    })
    // A reply: its thread opens, with the reply highlighted.
    const reply = parseDeepLink(
      "campflare://chat.example.com/archives/C1/p1700000000000200?thread_ts=1700000000.000100&cid=C1",
    )
    expect(reply && deepLinkHash(reply)).toBe("#/C1/1700000000.000100?msg=1700000000.000200")
    // A thread head's own link names itself as its thread: no thread to open.
    const head = parseDeepLink("campflare://x.test/archives/C1/p1700000000000100?thread_ts=1700000000.000100")
    expect(head && deepLinkHash(head)).toBe("#/C1?msg=1700000000.000100")
    // The conversation alone, or a message part that isn't one.
    expect(parseDeepLink("campflare://x.test/archives/C1")?.route).toEqual({ channel: "C1" })
    expect(parseDeepLink("campflare://x.test/archives/C1/pnope")?.route).toEqual({ channel: "C1" })
    expect(parseDeepLink("campflare://x.test/archives/C1/p1700000000000200?thread_ts=<b>")?.route).toEqual({
      channel: "C1",
      message: "1700000000.000200",
    })
  })

  it("names the server by host and port, in lowercase, and gives the browser's link", () => {
    const local = parseDeepLink("campflare://LocalHost:8787/archives/C1")
    expect(local?.server).toBe("localhost:8787")
    expect(local?.web).toBe("http://localhost:8787/archives/C1")
    expect(parseDeepLink("campflare://Chat.Example.COM/archives/C1")?.server).toBe("chat.example.com")
    expect(serverOf("https://Chat.Example.com/")).toBe("chat.example.com")
    expect(serverOf("http://localhost:8787")).toBe("localhost:8787")
    expect(serverOf("not a url")).toBe("not a url")
  })

  it("refuses what isn't a link to a conversation", () => {
    for (const href of [
      "https://x.test/archives/C1/p1700000000000100",
      "campflare:///archives/C1",
      "campflare://x.test/",
      "campflare://x.test/archives/c1",
      "campflare://x.test/archives/C1/p1700000000000100/more",
      "campflare://x.test/files/C1",
      "not a url",
    ])
      expect({ href, link: parseDeepLink(href) }).toEqual({ href, link: null })
  })
})

describe("platformDeepLinks", () => {
  it("is the deep-link plugin's API in the desktop shell, and nothing in a browser", async () => {
    expect(platformDeepLinks({})).toBeNull()
    expect(platformDeepLinks()).toBeNull()
    let heard: string[] = []
    const links = platformDeepLinks({
      __TAURI__: {
        deepLink: {
          getCurrent: async () => null,
          onOpenUrl: async (on) => {
            on(["campflare://x.test/archives/C1"])
            return () => {}
          },
        },
      },
    })!
    expect(await links.current()).toEqual([])
    await links.listen((urls) => (heard = urls))
    expect(heard).toEqual(["campflare://x.test/archives/C1"])
  })
})

/** A shell that was started with `startedWith` and hands over more links through `send`. */
function fakeLinks(startedWith: string[] = []) {
  let listener: ((urls: string[]) => void) | undefined
  const links: DeepLinks = {
    current: async () => startedWith,
    listen: async (on) => {
      listener = on
      return () => {
        if (listener === on) listener = undefined
      }
    },
  }
  const send = (url: string) => act(() => listener?.([url]))
  return { links, send }
}

const session: Session = { url: "https://x.test", token: "xoxp-1" }

async function signedIn(links: DeepLinks) {
  const store = browserStore()
  await store.save(session)
  const server = fakeServer()
  render(<App store={store} connect={server.connect} deepLinks={links} />)
  await screen.findByRole("status", { name: /Connected|Connecting/ })
  act(() => hello())
  return server
}

const linked = async () =>
  within(await screen.findByRole("log", { name: "Messages" })).findByRole("article", { current: true })

describe("the app given a link", () => {
  it("opens the message when it was started with a link to its server", async () => {
    const { links } = fakeLinks(["campflare://x.test/archives/CGEN/p1700000100000000"])
    await signedIn(links)
    expect((await linked()).textContent).toContain("first")
    expect(window.location.hash).toBe("#/CGEN?msg=1700000100.000000")
  })

  it("opens a link that comes while it runs, a reply in its thread", async () => {
    const { links, send } = fakeLinks()
    await signedIn(links)
    await screen.findByRole("heading", { name: "general", level: 1 })
    send("campflare://X.test/archives/CGEN/p1700000300000000?thread_ts=1700000200.000000&cid=CGEN")
    await waitFor(() => expect(window.location.hash).toBe("#/CGEN/1700000200.000000?msg=1700000300.000000"))
    const thread = await screen.findByRole("complementary", { name: "Thread" })
    expect((await within(thread).findByRole("article", { current: true })).textContent).toContain("a reply")
  })

  it("says a link is to another server, instead of not finding it, and offers the browser", async () => {
    const user = userEvent.setup()
    const { links, send } = fakeLinks()
    await signedIn(links)
    await screen.findByRole("heading", { name: "general", level: 1 })
    send("campflare://chat.other.test/archives/C9/p1700000100000000")
    const dialog = await screen.findByRole("dialog", { name: "This link is to another server" })
    expect(dialog.textContent).toContain("chat.other.test")
    expect(dialog.textContent).toContain("signed in to x.test")
    const browser = within(dialog).getByRole("link", { name: "Open in your browser" })
    expect(browser.getAttribute("href")).toBe("https://chat.other.test/archives/C9/p1700000100000000")
    // Where the app was, it stays: no not-found view.
    expect(window.location.hash).not.toContain("C9")
    expect(screen.queryByRole("heading", { name: "Conversation not found" })).toBeNull()
    await user.click(within(dialog).getByRole("button", { name: "Close" }))
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull())
  })

  it("keeps a link until the app is signed in, then opens it", async () => {
    const user = userEvent.setup()
    const { links } = fakeLinks(["campflare://x.test/archives/CGEN/p1700000100000000"])
    const server = fakeServer()
    render(<App store={browserStore()} connect={server.connect} fetch={server.api.fetch} deepLinks={links} />)
    await screen.findByRole("heading", { name: "Sign in to Campflare" })
    expect(window.location.hash).toBe("")
    await user.type(screen.getByLabelText("Server"), "https://x.test")
    await user.type(screen.getByLabelText("Token"), "xoxp-1")
    await user.click(screen.getByRole("button", { name: "Sign in with a token" }))
    await screen.findByRole("status", { name: /Connected|Connecting/ })
    act(() => hello())
    expect((await linked()).textContent).toContain("first")
  })

  it("says so when a link isn't one it can open", async () => {
    const { links, send } = fakeLinks()
    await signedIn(links)
    await screen.findByRole("heading", { name: "general", level: 1 })
    send("campflare://x.test/settings")
    expect(await screen.findByText("Campflare can't open campflare://x.test/settings")).toBeTruthy()
  })
})
