import type { Message } from "@campflare/core"
import { act, render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, describe, expect, it } from "vitest"
import { App } from "@/app"
import { browserStore } from "@/session"
import { fakeServer, FakeSocket, hello } from "./server"

// An app's streamed replies in the app: their tasks and plan.

afterEach(() => {
  FakeSocket.all = []
  localStorage.clear()
})

const TS = "1700000500.000000"

const streaming: Message = {
  ts: TS,
  channel: "CGEN",
  user: "UBOT",
  bot_id: "B1",
  app_id: "A1",
  text: "Thinking it over",
  blocks: [{ type: "markdown", block_id: "md", text: "Thinking it over" }],
  streaming_state: "in_progress",
}

const rich = (text: string) => ({
  type: "rich_text",
  elements: [{ type: "rich_text_section", elements: [{ type: "text", text }] }],
})

async function signedIn(messages: Message[], overrides: Parameters<typeof fakeServer>[0] = {}) {
  const server = fakeServer({ "conversations.history": () => ({ messages }), ...overrides })
  const store = browserStore()
  await store.save({ url: "https://x.test", token: "xoxp-1" })
  const user = userEvent.setup()
  render(<App store={store} connect={server.connect} />)
  await screen.findByRole("heading", { name: "general", level: 1 })
  act(() => hello())
  return { server, user }
}

const article = async (text: string) => (await screen.findByText(text)).closest("article")!

describe("an app's streamed reply", () => {
  it("shows tasks among the text, with their status, details, output and sources", async () => {
    await signedIn([
      {
        ...streaming,
        text: "Voy a buscarlo.",
        blocks: [
          { type: "markdown", text: "Voy a buscarlo." },
          {
            type: "task_card",
            task_id: "t1",
            title: "Recherche",
            status: "complete",
            details: rich("Requête: été"),
            output: rich("3 résultats"),
            sources: [
              { type: "url", url: "https://example.com/ko", text: "한국어 자료" },
              { type: "url", url: "javascript:alert(1)", text: "Nope" },
            ],
          },
          { type: "task_card", task_id: "t2", title: "検索する", status: "in_progress" },
          { type: "markdown", text: "Fertig." },
          { type: "task_card", task_id: "t3", title: "Write", status: "error" },
        ],
      },
    ])
    const message = within(await article("Voy a buscarlo."))
    const lists = message.getAllByRole("list", { name: "Tasks" })
    expect(lists).toHaveLength(2)
    expect(
      within(lists[0]!)
        .getAllByRole("listitem")
        .map((li) => li.firstElementChild?.nextElementSibling?.firstElementChild?.textContent),
    ).toEqual(["Recherche, Done", "検索する, In progress"])
    expect(message.getByText("Requête: été")).toBeTruthy()
    expect(message.getByText("3 résultats")).toBeTruthy()
    expect(message.getByRole("link", { name: "한국어 자료" }).getAttribute("href")).toBe("https://example.com/ko")
    expect(message.queryByRole("link", { name: "Nope" })).toBeNull()
    expect(within(lists[1]!).getByRole("listitem").textContent).toBe("Write, Failed")
    expect(message.getByText("Fertig.")).toBeTruthy()
  })

  it("shows a plan: its title, how far along it is, and its tasks", async () => {
    await signedIn([
      {
        ...streaming,
        text: "",
        blocks: [
          {
            type: "plan",
            title: "Plan de travail",
            tasks: [
              { type: "task_card", task_id: "a", title: "Lire", status: "complete" },
              { type: "task_card", task_id: "b", title: "書く", status: "pending" },
            ],
          },
          { type: "plan", title: "", tasks: [] },
        ],
      },
    ])
    const plan = within(await screen.findByRole("region", { name: "Plan de travail" }))
    expect(plan.getByText("1 of 2 done")).toBeTruthy()
    expect(plan.getAllByRole("listitem").map((li) => li.textContent)).toEqual(["Lire, Done", "書く, Pending"])
    // A plan without a title or tasks yet.
    expect(within(screen.getByRole("region", { name: "Plan" })).queryByRole("list")).toBeNull()
  })
})
