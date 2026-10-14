import { act, render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, describe, expect, it, vi } from "vitest"
import { App } from "@/app"
import { browserStore, type Session } from "@/session"
import { ALEX, fakeServer, FakeSocket, hello } from "./server"

// The routes the server's permalinks redirect to (/archives/… → #/C?msg=…):
// the linked message highlighted and scrolled to, older pages loaded to reach
// it, and a not-found view or notice when it isn't there.

const session: Session = { url: "https://x.test", token: "xoxp-1" }

afterEach(() => {
  FakeSocket.all = []
  localStorage.clear()
  vi.restoreAllMocks()
})

/** The app opened at a link's route, signed in. */
async function openAt(hash: string, server = fakeServer()) {
  window.location.hash = hash
  const store = browserStore()
  await store.save(session)
  render(<App store={store} connect={server.connect} />)
  await screen.findByRole("status", { name: /Connected|Connecting/ })
  act(() => hello())
  return server
}

const log = () => screen.getByRole("region", { name: "general" }).querySelector<HTMLElement>('[role="log"]')!
const thread = () => screen.getByRole("complementary", { name: "Thread" })

describe("links to a message", () => {
  it("highlight the message in its conversation and scroll to it", async () => {
    const scrolled = vi.spyOn(Element.prototype, "scrollIntoView")
    await openAt("#/CGEN?msg=1700000100.000000")
    const linked = await within(await screen.findByRole("log", { name: "Messages" })).findByRole("article", {
      current: true,
    })
    expect(linked.textContent).toContain("first")
    expect(linked.getAttribute("aria-label")).toMatch(/^Alex Rivera at /)
    expect(scrolled).toHaveBeenCalledWith({ block: "center" })
    expect(scrolled.mock.contexts.at(-1)).toBe(linked)
    // Only that one.
    expect(within(log()).getAllByRole("article", { current: true })).toHaveLength(1)
  })

  it("load older pages until the message is there", async () => {
    const server = fakeServer({
      "conversations.history": (args) =>
        args.latest === "1700000050.000000"
          ? { messages: [{ ts: "1700000020.000000", user: ALEX, text: "page two" }], has_more: true }
          : args.latest === "1700000020.000000"
            ? { messages: [{ ts: "1700000010.000000", user: ALEX, text: "¿Dónde está? 見つけた" }], has_more: true }
            : {
                messages: [{ ts: "1700000050.000000", channel: "CGEN", user: ALEX, text: "newest" }],
                has_more: true,
              },
    })
    await openAt("#/CGEN?msg=1700000010.000000", server)
    const linked = await within(await screen.findByRole("log", { name: "Messages" })).findByRole("article", {
      current: true,
    })
    expect(linked.textContent).toContain("見つけた")
    // Two pages back, and no further: the message was found.
    expect(server.api.calls.filter((c) => c.method === "conversations.history").map((c) => c.args.latest)).toEqual([
      undefined,
      "1700000050.000000",
      "1700000020.000000",
    ])
  })

  it("say so when the message isn't there, and the notice can be dismissed", async () => {
    const user = userEvent.setup()
    // Older than the oldest message, with nothing older: gone.
    const server = fakeServer({
      "conversations.history": () => ({
        messages: [{ ts: "1700000100.000000", channel: "CGEN", user: ALEX, text: "first" }],
        has_more: false,
      }),
    })
    await openAt("#/CGEN?msg=1700000001.000000", server)
    const notice = (await screen.findByText(/The linked message isn't here/)).closest('[role="status"]')
    expect(notice).toBeTruthy()
    await user.click(screen.getByRole("button", { name: "Dismiss" }))
    await waitFor(() => expect(window.location.hash).toBe("#/CGEN"))
    expect(screen.queryByText(/The linked message isn't here/)).toBeNull()
  })

  it("open a reply's thread with the reply highlighted, and its head in the conversation", async () => {
    await openAt("#/CGEN/1700000200.000000?msg=1700000300.000000")
    const reply = await within(await screen.findByRole("complementary", { name: "Thread" })).findByRole("article", {
      current: true,
    })
    expect(reply.textContent).toContain("a reply")
    const head = await within(log()).findByRole("article", { current: true })
    expect(head.textContent).toContain("Hi")
  })

  it("say so when the reply or the thread isn't there", async () => {
    await openAt("#/CGEN/1700000200.000000?msg=1700000399.000000")
    expect(await within(thread()).findByText(/The linked reply isn't in this thread/)).toBeTruthy()
    act(() => screen.getAllByRole("button", { name: "Close thread" })[0]!.click())
    await waitFor(() => expect(window.location.hash).toBe("#/CGEN"))
  })

  it("say a thread that's gone is gone, without a composer", async () => {
    await openAt(
      "#/CGEN/1700000222.000000?msg=1700000333.000000",
      fakeServer({ "conversations.replies": () => new Error("message_not_found") }),
    )
    expect(await within(thread()).findByText(/This thread isn't here/)).toBeTruthy()
    expect(within(thread()).queryByRole("textbox")).toBeNull()
  })

  it("show a not-found view for a conversation that isn't there, with a way back", async () => {
    const user = userEvent.setup()
    const server = await openAt("#/CNOPE/1700000200.000000?msg=1700000300.000000")
    expect(await screen.findByRole("heading", { name: "Conversation not found", level: 1 })).toBeTruthy()
    // No thread panel for a conversation that isn't there, and no attempt (and error toast) to load it.
    expect(screen.queryByRole("complementary", { name: "Thread" })).toBeNull()
    expect(server.api.calls.filter((c) => c.args.channel === "CNOPE")).toEqual([])
    await user.click(screen.getByRole("button", { name: "Back to your conversations" }))
    await screen.findByRole("heading", { name: "general", level: 1 })
    expect(window.location.hash).toBe("#/CGEN")
  })

  it("sign in first when signed out, then land on the message", async () => {
    const server = fakeServer()
    const user = userEvent.setup()
    window.location.hash = "#/CGEN?msg=1700000100.000000"
    render(<App store={browserStore()} connect={server.connect} fetch={server.api.fetch} />)
    await user.type(await screen.findByLabelText("Server"), "https://x.test")
    await user.type(screen.getByLabelText("Token"), "xoxp-1")
    await user.click(screen.getByRole("button", { name: "Sign in with a token" }))
    const linked = await within(await screen.findByRole("log", { name: "Messages" })).findByRole("article", {
      current: true,
    })
    expect(linked.textContent).toContain("first")
  })
})
