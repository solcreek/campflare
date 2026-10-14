import type { Message } from "@campflare/core"
import { act, render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, describe, expect, it } from "vitest"
import { App } from "@/app"
import { browserStore } from "@/session"
import { fakeServer, FakeSocket, hello } from "./server"

afterEach(() => {
  FakeSocket.all = []
  localStorage.clear()
})

const BOT = "UBOT"
const TS = "1700000500.000000"
const text = (t: string) => ({ type: "plain_text", text: t })

const fromApp: Message = {
  ts: TS,
  channel: "CGEN",
  user: BOT,
  bot_id: "B1",
  app_id: "A1",
  username: "Deploy",
  text: "Open the pull request?",
  blocks: [
    { type: "section", block_id: "ask", text: { type: "mrkdwn", text: "Open the pull request?" } },
    {
      type: "actions",
      block_id: "decide",
      elements: [
        { type: "button", action_id: "approve", text: text("Approve"), value: "pr-42", style: "primary" },
        {
          type: "button",
          action_id: "reject",
          text: text("Reject"),
          style: "danger",
          accessibility_label: "Reject the pull request",
        },
        { type: "button", action_id: "docs", text: text("Docs"), url: "https://docs.example/pr" },
      ],
    },
    {
      type: "context_actions",
      block_id: "rate",
      elements: [
        {
          type: "feedback_buttons",
          action_id: "feedback",
          positive_button: { text: text("Good"), value: "up", accessibility_label: "Good answer" },
          negative_button: { text: text("Bad"), value: "down" },
        },
      ],
    },
  ],
}

async function signedIn(messages: Message[] = [fromApp]) {
  const server = fakeServer({
    "conversations.history": () => ({ messages }),
    "campflare.blocks.action": () => ({ delivered: "http" }),
  })
  const store = browserStore()
  store.save({ url: "https://x.test", token: "xoxp-1" })
  const user = userEvent.setup()
  render(<App store={store} connect={server.connect} />)
  await screen.findByRole("heading", { name: "general", level: 1 })
  act(() => hello())
  const message = (await screen.findByText("Open the pull request?")).closest("article")!
  return { server, user, message: within(message) }
}

const clicks = (server: ReturnType<typeof fakeServer>) =>
  server.api.calls.filter((c) => c.method === "campflare.blocks.action").map((c) => c.args)

describe("buttons in messages", () => {
  it("shows an app's buttons by their names, styled, and a link button as a link", async () => {
    const { message } = await signedIn()
    const approve = message.getByRole("button", { name: "Approve" })
    expect(approve.className).toContain("bg-primary")
    expect(message.getByRole("button", { name: "Reject the pull request" }).className).toContain("destructive")
    const docs = message.getByRole("link", { name: "Docs" })
    expect(docs.getAttribute("href")).toBe("https://docs.example/pr")
    expect(docs.getAttribute("target")).toBe("_blank")
    expect(message.getByRole("button", { name: "Good answer" }).getAttribute("aria-pressed")).toBe("false")
    expect(message.getByRole("button", { name: "Bad" })).toBeTruthy()
  })

  it("sends a click to the app, waiting while it's on its way", async () => {
    const { server, user, message } = await signedIn()
    // Hold the click until the test lets it go.
    let release!: () => void
    const held = new Promise<void>((r) => (release = r))
    const call = server.api.client.call.bind(server.api.client)
    server.api.client.call = (async (method: string, args?: Parameters<typeof call>[1]) => {
      if (method === "campflare.blocks.action") await held
      return call(method, args)
    }) as typeof server.api.client.call

    await user.click(message.getByRole("button", { name: "Approve" }))
    const approve = message.getByRole("button", { name: "Approve" })
    expect(approve.getAttribute("aria-busy")).toBe("true")
    expect(message.getByRole("button", { name: "Reject the pull request" }).hasAttribute("disabled")).toBe(true)
    release()
    await waitFor(() => expect(approve.hasAttribute("aria-busy")).toBe(false))
    expect(approve.hasAttribute("disabled")).toBe(false)
    expect(clicks(server)).toEqual([
      { channel: "CGEN", ts: TS, block_id: "decide", action_id: "approve", value: "pr-42" },
    ])

    // A link button opens its page and still tells the app.
    const docs = message.getByRole("link", { name: "Docs" })
    docs.addEventListener("click", (e) => e.preventDefault())
    await user.click(docs)
    await waitFor(() => expect(clicks(server)).toHaveLength(2))
    expect(clicks(server)[1]).toEqual({ channel: "CGEN", ts: TS, block_id: "decide", action_id: "docs" })
  })

  it("gives feedback once the app takes it, and says when it doesn't", async () => {
    const { server, user, message } = await signedIn()
    await user.click(message.getByRole("button", { name: "Good answer" }))
    await waitFor(() =>
      expect(message.getByRole("button", { name: "Good answer" }).getAttribute("aria-pressed")).toBe("true"),
    )
    expect(clicks(server)).toEqual([{ channel: "CGEN", ts: TS, block_id: "rate", action_id: "feedback", value: "up" }])

    server.api.handlers["campflare.blocks.action"] = () => new Error("app_unreachable")
    await user.click(message.getByRole("button", { name: "Bad" }))
    expect((await message.findByRole("alert")).textContent).toBe("The app didn't take that (app_unreachable).")
    expect(message.getByRole("button", { name: "Bad" }).getAttribute("aria-pressed")).toBe("false")
    expect(message.getByRole("button", { name: "Good answer" }).getAttribute("aria-pressed")).toBe("true")
    // The next click starts afresh.
    server.api.handlers["campflare.blocks.action"] = () => ({ delivered: "socket" })
    await user.click(message.getByRole("button", { name: "Approve" }))
    await waitFor(() => expect(message.queryByRole("alert")).toBeNull())
  })

  it("shows the app's answer: the message replaced without its buttons", async () => {
    const { server, message } = await signedIn()
    act(() =>
      server.push({
        type: "message",
        subtype: "message_changed",
        channel: "CGEN",
        message: { ...fromApp, text: "Approved by alex", blocks: undefined },
        previous_message: fromApp,
      }),
    )
    await waitFor(() => expect(message.queryByRole("button", { name: "Approve" })).toBeNull())
    expect(message.getByText("Approved by alex")).toBeTruthy()
  })

  it("shows a streamed reply's markdown with its feedback buttons under it", async () => {
    const streamed: Message = {
      ...fromApp,
      text: "Open the pull request?",
      blocks: [{ type: "markdown", block_id: "md", text: "Open the pull request?" }, fromApp.blocks![2]!],
    }
    const { server, user, message } = await signedIn([streamed])
    expect(message.queryByRole("button", { name: "Approve" })).toBeNull()
    await user.click(message.getByRole("button", { name: "Bad" }))
    await waitFor(() => expect(message.getByRole("button", { name: "Bad" }).getAttribute("aria-pressed")).toBe("true"))
    expect(clicks(server)).toEqual([
      { channel: "CGEN", ts: TS, block_id: "rate", action_id: "feedback", value: "down" },
    ])
  })

  it("keeps the buttons of a message only you see inert", async () => {
    const { server, message } = await signedIn([{ ...fromApp, is_ephemeral: true }])
    expect(message.getByRole("button", { name: "Approve" }).hasAttribute("disabled")).toBe(true)
    expect(message.getByRole("link", { name: "Docs" }).getAttribute("aria-disabled")).toBe("true")
    message.getByRole("link", { name: "Docs" }).addEventListener("click", (e) => e.preventDefault())
    message.getByRole("link", { name: "Docs" }).click()
    expect(clicks(server)).toEqual([])
  })
})
