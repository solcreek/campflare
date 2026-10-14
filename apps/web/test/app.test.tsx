import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import type { ReactElement } from "react"
import userEvent from "@testing-library/user-event"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { Fetch } from "@campflare/client"
import { App } from "@/app"
import { browserStore, REVOKE_TIMEOUT_MS, type Session, type SessionStore } from "@/session"
import { ALEX, fakeServer, FakeSocket, hello, VINCENT } from "./server"

afterEach(() => {
  FakeSocket.all = []
  localStorage.clear()
})

const session: Session = { url: "https://x.test", token: "xoxp-1" }

async function signedIn(server = fakeServer()) {
  const store = browserStore()
  await store.save(session)
  const user = userEvent.setup()
  render(<App store={store} connect={server.connect} />)
  await screen.findByRole("heading", { name: "general", level: 1 })
  act(() => hello())
  return { server, user, store }
}

const failing = () => Promise.reject(new TypeError("Failed to fetch"))

function cleanupAndRender(ui: ReactElement) {
  cleanup()
  render(ui)
}

const log = () => screen.getByRole("log", { name: "Messages" })

describe("App", () => {
  it("signs in with a token checked by auth.test", async () => {
    const server = fakeServer()
    const store = browserStore()
    const user = userEvent.setup()
    render(<App store={store} connect={server.connect} fetch={server.api.fetch} />)
    // The store answers asynchronously (the desktop keychain is behind IPC).
    expect(screen.getByText("Loading…")).toBeTruthy()
    expect(await screen.findByRole("heading", { name: "Sign in to Campflare" })).toBeTruthy()
    const url = screen.getByLabelText("Server")
    await user.clear(url)
    await user.type(url, "https://x.test")

    // A wrong token: auth.test's error code, and nothing kept.
    server.api.handlers["auth.test"] = () => new Error("invalid_auth")
    await user.type(screen.getByLabelText("Token"), "xoxp-bad")
    await user.click(screen.getByRole("button", { name: "Sign in with a token" }))
    expect((await screen.findByRole("alert")).textContent).toBe("invalid_auth")
    expect(await store.load()).toBeNull()

    // An unreachable server.
    cleanupAndRender(<App store={store} connect={server.connect} fetch={failing} />)
    // A server that wasn't signed in to isn't remembered: the field starts empty.
    expect(((await screen.findByLabelText("Server")) as HTMLInputElement).value).toBe("")
    await user.type(screen.getByLabelText("Token"), "xoxp-1")
    await user.click(screen.getByRole("button", { name: "Sign in with a token" }))
    expect((await screen.findByRole("alert")).textContent).toBe("Enter the server's address")
    await user.type(screen.getByLabelText("Server"), "https://x.test")
    await user.click(screen.getByRole("button", { name: "Sign in with a token" }))
    expect((await screen.findByRole("alert")).textContent).toBe("Couldn't reach the server")

    // The right one: kept, and the workspace opens.
    server.api.handlers["auth.test"] = () => ({ user_id: ALEX, team_id: "T1", team: "Test Team" })
    cleanupAndRender(<App store={store} connect={server.connect} fetch={server.api.fetch} />)
    await user.clear(await screen.findByLabelText("Server"))
    await user.type(screen.getByLabelText("Server"), " https://x.test ")
    await user.type(screen.getByLabelText("Token"), "xoxp-1")
    await user.click(screen.getByRole("button", { name: "Sign in with a token" }))
    await screen.findByRole("heading", { name: "general", level: 1 })
    expect(await store.load()).toEqual({ url: "https://x.test", token: "xoxp-1", via: "token" })
  })

  it("treats a store it can't read as signed out, and says when one can't keep the session", async () => {
    const server = fakeServer()
    const broken: SessionStore = {
      load: () => Promise.reject(new Error("locked")),
      save: () => Promise.reject(new Error("access denied")),
      clear: () => Promise.reject("gone"),
    }
    const user = userEvent.setup()
    render(<App store={broken} connect={server.connect} fetch={server.api.fetch} />)
    await user.type(await screen.findByLabelText("Server"), "https://x.test")
    await user.type(screen.getByLabelText("Token"), "xoxp-1")
    await user.click(screen.getByRole("button", { name: "Sign in with a token" }))
    // Signed in for now, but it won't last past a restart.
    await screen.findByRole("heading", { name: "general", level: 1 })
    const notice = await screen.findByText("Couldn't keep the sign-in: access denied")
    // At the top: at the bottom right a toast covered the composer's Send button.
    expect(notice.closest("[data-sonner-toaster]")?.getAttribute("data-y-position")).toBe("top")
    act(() => hello())
    await user.click(screen.getByRole("button", { name: /Test Team/ }))
    await user.click(await screen.findByRole("menuitem", { name: "Sign out" }))
    expect(await screen.findByText("Couldn't forget the sign-in: gone")).toBeTruthy()
    expect(screen.getByRole("heading", { name: "Sign in to Campflare" })).toBeTruthy()
  })

  it("opens #general by default, with its history and live status", async () => {
    await signedIn()
    expect(window.location.hash).toBe("#/CGEN")
    expect(within(log()).getByText("first")).toBeTruthy()
    // mrkdwn: bold, a user mention and a channel mention
    expect(within(log()).getByText("Hi").tagName).toBe("STRONG")
    expect(within(log()).getByText("@Alex Rivera")).toBeTruthy()
    expect(within(log()).getByText("#dev")).toBeTruthy()
    // A join is one quiet line.
    expect(within(log()).getByText("has joined the channel", { exact: false })).toBeTruthy()
    expect(screen.getByText("Company-wide")).toBeTruthy()
    expect(screen.getByRole("status", { name: "Connected" })).toBeTruthy()
    // Sidebar: your channels and DMs; #random isn't yours.
    const channels = screen.getByRole("navigation", { name: "Channels" })
    expect(within(channels).getAllByRole("button", { name: /^(dev|general)$/ })).toHaveLength(2)
    expect(within(screen.getByRole("navigation", { name: "Direct messages" })).getByText("Vincent Vega")).toBeTruthy()
  })

  it("sends on Enter, but not while an IME composes", async () => {
    const { server, user } = await signedIn()
    const box = screen.getByRole("textbox", { name: "Message #general" })
    await user.type(box, "早安")
    // The Enter that confirms a CJK composition must not send.
    fireEvent.keyDown(box, { key: "Enter", isComposing: true })
    fireEvent.keyDown(box, { key: "Enter", keyCode: 229 })
    expect(server.api.calls.some((c) => c.method === "chat.postMessage")).toBe(false)
    await user.type(box, "{Shift>}{Enter}{/Shift}Bonjour")
    await user.type(box, "{Enter}")
    await within(log()).findByText(/早安\s*Bonjour/)
    expect(server.api.calls.find((c) => c.method === "chat.postMessage")?.args).toMatchObject({
      channel: "CGEN",
      text: "早安\nBonjour",
    })
    expect((box as HTMLTextAreaElement).value).toBe("")
  })

  it("shows a failed send with Retry and Discard", async () => {
    const server = fakeServer({ "chat.postMessage": () => new Error("is_archived") })
    const { user } = await signedIn(server)
    await user.type(screen.getByRole("textbox", { name: "Message #general" }), "lost{Enter}")
    expect((await screen.findByRole("alert")).textContent).toContain("is_archived")
    server.api.handlers["chat.postMessage"] = () => ({ ts: "1700009999.000000" })
    await user.click(screen.getByRole("button", { name: "Retry" }))
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull())

    server.api.handlers["chat.postMessage"] = () => new Error("rate_limited")
    await user.type(screen.getByRole("textbox", { name: "Message #general" }), "again{Enter}")
    await screen.findByRole("alert")
    await user.click(screen.getByRole("button", { name: "Discard" }))
    expect(within(log()).queryByText("again")).toBeNull()
  })

  it("shows live messages and unread counts", async () => {
    const { server } = await signedIn()
    act(() => server.push({ type: "message", channel: "CGEN", ts: "1700000400.000000", user: VINCENT, text: "live!" }))
    await within(log()).findByText("live!")
    act(() => server.push({ type: "message", channel: "CDEV", ts: "1700000500.000000", user: VINCENT, text: "in dev" }))
    expect(await screen.findByLabelText("1 unread")).toBeTruthy()
  })

  it("loads older messages on request", async () => {
    const { server, user } = await signedIn()
    await user.click(screen.getByRole("button", { name: "Load older messages" }))
    expect(server.api.calls.at(-1)).toMatchObject({
      method: "conversations.history",
      args: { latest: "1700000050.000000" },
    })
  })

  it("opens a thread, replies in it and closes it", async () => {
    const { server, user } = await signedIn()
    await user.click(screen.getByRole("button", { name: "1 reply" }))
    expect(window.location.hash).toBe("#/CGEN/1700000200.000000")
    const thread = await screen.findByRole("complementary", { name: "Thread" })
    await within(thread).findByText("a reply")
    await user.type(within(thread).getByRole("textbox", { name: "Reply…" }), "in thread{Enter}")
    await within(thread).findByText("in thread")
    expect(server.api.calls.find((c) => c.method === "chat.postMessage")?.args.thread_ts).toBe("1700000200.000000")
    await user.click(screen.getByRole("button", { name: "Close thread" }))
    await waitFor(() => expect(screen.queryByRole("complementary", { name: "Thread" })).toBeNull())
  })

  it("toggles reactions from the bar and the picker", async () => {
    const { server, user } = await signedIn()
    const eyes = within(log()).getByRole("button", { name: "eyes, 1" })
    expect(eyes.getAttribute("aria-pressed")).toBe("false")
    await user.click(eyes)
    expect(within(log()).getByRole("button", { name: "eyes, 2" }).getAttribute("aria-pressed")).toBe("true")
    expect(server.api.calls.at(-1)).toMatchObject({ method: "reactions.add", args: { name: "eyes" } })

    const article = within(log()).getAllByRole("article")[1]!
    await user.click(within(article).getByRole("button", { name: "Add reaction" }))
    await user.click(await screen.findByRole("button", { name: "React with tada" }))
    expect(server.api.calls.at(-1)).toMatchObject({ method: "reactions.add", args: { name: "tada" } })
    expect(within(article).getByRole("button", { name: "tada, 1" })).toBeTruthy()
  })

  it("reports a reaction the server refused", async () => {
    const server = fakeServer({ "reactions.add": () => new Error("too_many_reactions") })
    const { user } = await signedIn(server)
    await user.click(within(log()).getByRole("button", { name: "eyes, 1" }))
    expect(await screen.findByText("Couldn't react: too_many_reactions")).toBeTruthy()
    expect(within(log()).getByRole("button", { name: "eyes, 1" })).toBeTruthy()
  })

  it("edits and deletes your own messages", async () => {
    const { server, user } = await signedIn()
    const mine = within(log()).getByText("first").closest("article")!
    await user.click(within(mine as HTMLElement).getByRole("button", { name: "Edit message" }))
    const editor = screen.getByRole("textbox", { name: "Edit message" })
    await user.clear(editor)
    await user.type(editor, "first, fixed{Enter}")
    await within(log()).findByText("first, fixed")
    expect(within(log()).getByText("(edited)")).toBeTruthy()

    // Escape cancels.
    const again = within(log()).getByText("first, fixed").closest("article") as HTMLElement
    await user.click(within(again).getByRole("button", { name: "Edit message" }))
    await user.type(screen.getByRole("textbox", { name: "Edit message" }), "{Escape}")
    expect(screen.queryByRole("textbox", { name: "Edit message" })).toBeNull()

    await user.click(within(again).getByRole("button", { name: "Delete message" }))
    await waitFor(() => expect(within(log()).queryByText("first, fixed")).toBeNull())
    expect(server.api.calls.at(-1)).toMatchObject({ method: "chat.delete", args: { ts: "1700000100.000000" } })
    // Others' messages offer no edit or delete.
    const theirs = within(log()).getByText("Hi").closest("article") as HTMLElement
    expect(within(theirs).queryByRole("button", { name: "Edit message" })).toBeNull()
    void ALEX
  })

  it("creates a channel, and joins one you aren't in", async () => {
    const { server, user } = await signedIn()
    await user.click(screen.getByRole("button", { name: "Add channels" }))
    const dialog = await screen.findByRole("dialog")
    await user.click(within(dialog).getByRole("button", { name: "random" }))
    await screen.findByRole("heading", { name: "random", level: 1 })
    await user.click(screen.getByRole("button", { name: "Join channel" }))
    await screen.findByRole("textbox", { name: "Message #random" })

    await user.click(screen.getByRole("button", { name: "Add channels" }))
    await user.type(await screen.findByRole("textbox", { name: "New channel name" }), "Release Notes")
    await user.click(screen.getByRole("button", { name: "Create" }))
    await screen.findByRole("heading", { name: "release-notes", level: 1 })
    expect(server.api.calls.find((c) => c.method === "conversations.create")?.args.name).toBe("release-notes")
    expect(window.location.hash).toBe("#/CNEW")
  })

  it("moves between conversations from the sidebar", async () => {
    const { user } = await signedIn()
    await user.click(screen.getByRole("button", { name: "Vincent Vega" }))
    await screen.findByRole("heading", { name: "Vincent Vega", level: 1 })
    expect(screen.getByRole("textbox", { name: "Message Vincent Vega" })).toBeTruthy()
    expect(within(log()).getByText("No messages yet.")).toBeTruthy()
    window.location.hash = "#/CNOPE"
    window.dispatchEvent(new HashChangeEvent("hashchange"))
    expect(await screen.findByRole("heading", { name: "Conversation not found", level: 1 })).toBeTruthy()
  })

  it("signs out from the team menu", async () => {
    const { user, store } = await signedIn()
    await user.click(screen.getByRole("button", { name: /Test Team/ }))
    await user.click(await screen.findByRole("menuitem", { name: "Sign out" }))
    expect(await screen.findByRole("heading", { name: "Sign in to Campflare" })).toBeTruthy()
    expect(await store.load()).toBeNull()
  })

  it("revokes the token on sign-out when it came from the browser sign-in, never a pasted one", async () => {
    const revokes = (server: ReturnType<typeof fakeServer>) =>
      server.api.calls.filter((c) => c.method === "auth.revoke").length
    const signOut = async (via: Session["via"], server = fakeServer({ "auth.revoke": () => ({ revoked: true }) })) => {
      cleanup()
      const store = browserStore()
      await store.save({ ...session, via })
      const user = userEvent.setup()
      render(<App store={store} connect={server.connect} fetch={server.api.fetch} />)
      await screen.findByRole("heading", { name: "general", level: 1 })
      act(() => hello())
      await user.click(screen.getByRole("button", { name: /Test Team/ }))
      await user.click(await screen.findByRole("menuitem", { name: "Sign out" }))
      expect(await screen.findByRole("heading", { name: "Sign in to Campflare" })).toBeTruthy()
      expect(await store.load()).toBeNull()
      return server
    }
    expect(revokes(await signOut("oauth"))).toBe(1)
    expect(revokes(await signOut("token"))).toBe(0)
    expect(revokes(await signOut(undefined))).toBe(0)
    // The server refusing still signs out here.
    expect(revokes(await signOut("oauth", fakeServer({ "auth.revoke": () => new Error("invalid_auth") })))).toBe(1)
  })

  it("signs out without waiting forever on a server that doesn't answer", async () => {
    const server = fakeServer()
    const store = browserStore()
    await store.save({ ...session, via: "oauth" })
    let answer: (() => void) | undefined
    const hanging: Fetch = (input, init) =>
      String(input).endsWith("/auth.revoke")
        ? new Promise((_, fail) => {
            answer = () => fail(new DOMException("aborted", "AbortError"))
            init?.signal?.addEventListener("abort", answer)
          })
        : server.api.fetch(input, init)
    const user = userEvent.setup()
    render(<App store={store} connect={server.connect} fetch={hanging} />)
    await screen.findByRole("heading", { name: "general", level: 1 })
    act(() => hello())
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      await user.click(screen.getByRole("button", { name: /Test Team/ }))
      await user.click(await screen.findByRole("menuitem", { name: "Sign out" }))
      expect(await screen.findByText("Signing out…")).toBeTruthy()
      expect(answer).toBeDefined()
      await act(() => vi.advanceTimersByTimeAsync(REVOKE_TIMEOUT_MS))
      expect(await screen.findByRole("heading", { name: "Sign in to Campflare" })).toBeTruthy()
      expect(await store.load()).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it("offers a retry when the workspace fails to load", async () => {
    const server = fakeServer({ "auth.test": () => new Error("account_inactive") })
    const store = browserStore()
    const user = userEvent.setup()
    render(<App store={store} autoSession={session} connect={server.connect} />)
    expect((await screen.findByRole("alert")).textContent).toContain("account_inactive")
    server.api.handlers["auth.test"] = () => ({ user_id: ALEX, team_id: "T1", team: "Test Team" })
    await user.click(screen.getByRole("button", { name: "Try again" }))
    await screen.findByRole("heading", { name: "general", level: 1 })
    // autoSession is never written to the store.
    expect(await store.load()).toBeNull()
  })
})
