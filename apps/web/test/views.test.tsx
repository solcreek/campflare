import type { View } from "@campflare/core"
import type { Handler } from "@campflare/core/testing"
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

const text = (t: string) => ({ type: "plain_text", text: t })
const option = (t: string, value: string) => ({ text: text(t), value })

const FORM: View = {
  id: "V1",
  type: "modal",
  hash: "1.A",
  title: { text: "Deploy" },
  submit: { text: "Deploy" },
  close: { text: "Cancel" },
  blocks: [
    { type: "section", block_id: "intro", text: { type: "mrkdwn", text: "Ship *pr-42*?" } },
    {
      type: "input",
      block_id: "note",
      label: text("Release note"),
      hint: text("What changed"),
      element: { type: "plain_text_input", action_id: "text", multiline: true },
    },
    {
      type: "input",
      block_id: "env",
      label: text("Environment"),
      element: {
        type: "static_select",
        action_id: "pick",
        options: [option("Production", "prod"), option("Staging", "staging")],
        initial_option: option("Staging", "staging"),
      },
    },
    {
      type: "input",
      block_id: "reviewer",
      label: text("Reviewer"),
      optional: true,
      element: { type: "users_select", action_id: "who" },
    },
    {
      type: "input",
      block_id: "checks",
      label: text("Checks"),
      optional: true,
      element: {
        type: "checkboxes",
        action_id: "boxes",
        options: [
          { ...option("Migrar", "migrate"), description: text("Run migrations first") },
          option("Prüfen", "check"),
        ],
      },
    },
    {
      type: "input",
      block_id: "speed",
      label: text("Speed"),
      element: { type: "radio_buttons", action_id: "radio", options: [option("Fast", "fast"), option("Slow", "slow")] },
    },
    {
      type: "input",
      block_id: "day",
      label: text("Day"),
      optional: true,
      element: { type: "datepicker", action_id: "date", initial_date: "2026-10-14" },
    },
    {
      type: "input",
      block_id: "count",
      label: text("Replicas"),
      optional: true,
      element: { type: "number_input", action_id: "n", is_decimal_allowed: false },
    },
    {
      type: "input",
      block_id: "rich",
      label: text("Notes"),
      optional: true,
      element: { type: "rich_text_input", action_id: "r" },
    },
    {
      type: "actions",
      block_id: "tools",
      elements: [{ type: "button", action_id: "preview", text: text("Preview"), value: "p" }],
    },
  ],
}

async function opened(handlers: Record<string, Handler> = {}) {
  const server = fakeServer({
    "campflare.views.list": () => ({ views: [FORM] }),
    "campflare.views.close": () => ({ views: [] }),
    "campflare.blocks.action": () => ({ delivered: "http" }),
    ...handlers,
  })
  const store = browserStore()
  store.save({ url: "https://x.test", token: "xoxp-1" })
  const user = userEvent.setup()
  render(<App store={store} connect={server.connect} />)
  // The view open for you is listed as the workspace loads; as a modal it hides the rest.
  const dialog = await screen.findByRole("dialog", { name: "Deploy" })
  act(() => hello())
  return { server, user, dialog: within(dialog), element: dialog }
}

const calls = (server: ReturnType<typeof fakeServer>, method: string) =>
  server.api.calls.filter((c) => c.method === method).map((c) => c.args)

describe("a modal an app opened", () => {
  it("shows its blocks and labelled inputs, starting from their initial values", async () => {
    const { dialog } = await opened()
    expect(dialog.getByText("pr-42")).toBeTruthy()
    const note = dialog.getByRole("textbox", { name: "Release note" })
    expect(note.getAttribute("aria-required")).toBe("true")
    expect(note.getAttribute("aria-describedby")).toBeTruthy()
    expect(dialog.getByText("What changed")).toBeTruthy()
    expect((dialog.getByRole("combobox", { name: "Environment" }) as HTMLSelectElement).value).toBe("staging")
    expect(
      [...(dialog.getByRole("combobox", { name: "Reviewer (optional)" }) as HTMLSelectElement).options].map(
        (o) => o.text,
      ),
    ).toEqual(["Choose…", "Alex Rivera", "Vincent Vega"])
    expect(dialog.getByRole("group", { name: "Checks (optional)" })).toBeTruthy()
    expect(dialog.getByText("Run migrations first")).toBeTruthy()
    expect((dialog.getByLabelText("Day (optional)") as HTMLInputElement).value).toBe("2026-10-14")
    expect(dialog.getByRole("spinbutton", { name: "Replicas (optional)" })).toBeTruthy()
    expect(dialog.getByText("This input (rich_text_input) can't be filled in here yet.")).toBeTruthy()
    expect(dialog.getByRole("button", { name: "Cancel" })).toBeTruthy()
  })

  it("submits what the inputs hold, and shows the errors to fix, focusing the first", async () => {
    let answer: Record<string, unknown> = { views: [FORM], errors: { note: "Say a bit more", speed: "Pick one" } }
    const { server, user, dialog } = await opened({ "campflare.views.submit": () => answer })
    await user.type(dialog.getByRole("textbox", { name: "Release note" }), "Ship ✨")
    await user.selectOptions(dialog.getByRole("combobox", { name: "Environment" }), "prod")
    await user.selectOptions(dialog.getByRole("combobox", { name: "Reviewer (optional)" }), "U2")
    await user.click(dialog.getByRole("checkbox", { name: /Migrar/ }))
    await user.click(dialog.getByRole("checkbox", { name: "Prüfen" }))
    await user.click(dialog.getByRole("checkbox", { name: /Migrar/ }))
    await user.click(dialog.getByRole("button", { name: "Deploy" }))
    await waitFor(() => expect(calls(server, "campflare.views.submit")).toHaveLength(1))
    expect(JSON.parse(calls(server, "campflare.views.submit")[0]!.values!)).toEqual({
      note: { text: "Ship ✨" },
      env: { pick: "prod" },
      reviewer: { who: "U2" },
      checks: { boxes: ["check"] },
      day: { date: "2026-10-14" },
    })
    const note = dialog.getByRole("textbox", { name: "Release note" })
    await waitFor(() => expect(note.getAttribute("aria-invalid")).toBe("true"))
    expect(dialog.getByText("Say a bit more")).toBeTruthy()
    expect(dialog.getByText("Pick one")).toBeTruthy()
    expect(document.activeElement).toBe(note)

    // Fixed and sent again: the app takes it and the modal goes.
    await user.click(dialog.getByRole("radio", { name: "Slow" }))
    answer = { views: [], delivered: "http" }
    await user.click(dialog.getByRole("button", { name: "Deploy" }))
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull())
    expect(JSON.parse(calls(server, "campflare.views.submit")[1]!.values!)).toMatchObject({ speed: { radio: "slow" } })
  })

  it("says when the app can't be reached, keeping what was typed", async () => {
    const { user, dialog } = await opened({ "campflare.views.submit": () => new Error("app_unreachable") })
    await user.type(dialog.getByRole("textbox", { name: "Release note" }), "x")
    await user.click(dialog.getByRole("button", { name: "Deploy" }))
    expect((await dialog.findByRole("alert")).textContent).toBe("The app didn't take that (app_unreachable).")
    expect((dialog.getByRole("textbox", { name: "Release note" }) as HTMLTextAreaElement).value).toBe("x")
  })

  it("sends a click in the modal with what's typed so far", async () => {
    const { server, user, dialog } = await opened()
    await user.type(dialog.getByRole("textbox", { name: "Release note" }), "half")
    await user.click(dialog.getByRole("button", { name: "Preview" }))
    await waitFor(() => expect(calls(server, "campflare.blocks.action")).toHaveLength(1))
    const { values, ...click } = calls(server, "campflare.blocks.action")[0]!
    expect(click).toEqual({ view_id: "V1", block_id: "tools", action_id: "preview", value: "p" })
    expect(JSON.parse(values!)).toEqual({
      note: { text: "half" },
      env: { pick: "staging" },
      day: { date: "2026-10-14" },
    })
  })

  it("closes with Escape or Cancel, showing the view under it, and follows the app's changes", async () => {
    const pushed: View = { id: "V2", type: "modal", hash: "1.B", title: { text: "Sure?" }, blocks: [] }
    const { server, user } = await opened({
      "campflare.views.close": (args) => ({ views: args.view_id === "V2" ? [FORM] : [] }),
    })
    act(() => server.push({ type: "views_changed", views: [FORM, pushed] }))
    await screen.findByRole("dialog", { name: "Sure?" })
    await user.keyboard("{Escape}")
    await screen.findByRole("dialog", { name: "Deploy" })
    expect(calls(server, "campflare.views.close")).toEqual([{ view_id: "V2" }])
    // An update (a new hash) starts the form again from its initial values.
    act(() =>
      server.push({ type: "views_changed", views: [{ ...FORM, hash: "2.A", title: { text: "Deploy again" } }] }),
    )
    const again = within(await screen.findByRole("dialog", { name: "Deploy again" }))
    await user.click(again.getByRole("button", { name: "Cancel" }))
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull())
    expect(calls(server, "campflare.views.close").at(-1)).toEqual({ view_id: "V1" })
  })
})
