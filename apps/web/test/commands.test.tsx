import type { Handler } from "@campflare/core/testing"
import { act, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, describe, expect, it } from "vitest"
import { App } from "@/app"
import { browserStore } from "@/session"
import { fakeServer, FakeSocket, hello } from "./server"

afterEach(() => {
  FakeSocket.all = []
  localStorage.clear()
})

const COMMANDS = [
  { command: "/deploy", description: "Deploy a branch", usage_hint: "[branch]", app_id: "A1", app_name: "Deployer" },
  { command: "/debug", description: "Débogue", usage_hint: "", app_id: "A1", app_name: "Deployer" },
  { command: "/部署", description: "デプロイ 배포", usage_hint: "", app_id: "A1", app_name: "Deployer" },
]

async function signedIn(handlers: Record<string, Handler> = {}) {
  const server = fakeServer({
    "campflare.commands.list": () => ({ commands: COMMANDS }),
    "campflare.commands.invoke": () => ({ delivered: "http" }),
    "chat.postMessage": (args) => ({
      channel: args.channel,
      ts: "1700000300.000000",
      message: { ts: "1700000300.000000", user: "U1", text: args.text },
    }),
    ...handlers,
  })
  const store = browserStore()
  store.save({ url: "https://x.test", token: "xoxp-1" })
  const user = userEvent.setup()
  render(<App store={store} connect={server.connect} />)
  const box = await screen.findByRole("textbox", { name: "Message #general" })
  act(() => hello())
  return { server, user, box }
}

const calls = (server: ReturnType<typeof fakeServer>, method: string) =>
  server.api.calls.filter((c) => c.method === method).map((c) => c.args)

const offered = () => screen.queryAllByRole("option").map((o) => o.textContent)

describe("slash commands in the composer", () => {
  it("offers the commands as the name is typed, and picks one with the keyboard", async () => {
    const { user, box } = await signedIn()
    await user.type(box, "/de")
    expect(screen.getByRole("listbox", { name: "Commands" })).toBeTruthy()
    expect(offered()).toEqual(["/debugDébogueDeployer", "/deploy[branch]Deploy a branchDeployer"])
    expect(box.getAttribute("aria-activedescendant")).toBe(screen.getAllByRole("option")[0]!.id)
    await user.keyboard("{ArrowDown}")
    expect(screen.getByRole("option", { selected: true }).textContent).toContain("/deploy")
    await user.keyboard("{Tab}")
    expect((box as HTMLTextAreaElement).value).toBe("/deploy ")
    expect(screen.queryByRole("listbox")).toBeNull()
    // Escape hides the list for what's typed.
    await user.clear(box)
    await user.type(box, "/")
    expect(offered()).toHaveLength(3)
    await user.keyboard("{Escape}")
    expect(screen.queryByRole("listbox")).toBeNull()
    await user.type(box, "部")
    expect(offered()).toEqual(["/部署デプロイ 배포Deployer"])
    await user.click(screen.getByRole("option"))
    expect((box as HTMLTextAreaElement).value).toBe("/部署 ")
  })

  it("runs a registered command instead of sending it, and sends anything else as a message", async () => {
    const { server, user, box } = await signedIn()
    await user.type(box, "/deploy staging{Enter}")
    await waitFor(() => expect(calls(server, "campflare.commands.invoke")).toHaveLength(1))
    expect(calls(server, "campflare.commands.invoke")[0]).toEqual({
      channel: "CGEN",
      command: "/deploy",
      text: "staging",
    })
    expect((box as HTMLTextAreaElement).value).toBe("")
    // Enter on a half-typed name picks it first.
    await user.type(box, "/depl{Enter}")
    expect((box as HTMLTextAreaElement).value).toBe("/deploy ")
    await user.clear(box)
    await user.type(box, "/shrug ok{Enter}")
    await waitFor(() => expect(calls(server, "chat.postMessage")).toHaveLength(1))
    expect(calls(server, "chat.postMessage")[0]).toMatchObject({ text: "/shrug ok" })
    expect(calls(server, "campflare.commands.invoke")).toHaveLength(1)
  })

  it("keeps the draft while the command is on its way, and gives it back when it fails", async () => {
    let answer: (value: Record<string, unknown> | Error) => void = () => {}
    const { server, user, box } = await signedIn()
    // An answer the test releases: the call stays pending until then.
    const pending = () => new Promise<Record<string, unknown> | Error>((resolve) => (answer = resolve))
    const call = server.api.client.call.bind(server.api.client)
    server.api.client.call = (async (method: string, args?: Parameters<typeof call>[1]) => {
      if (method !== "campflare.commands.invoke") return call(method, args)
      const r = await pending()
      if (r instanceof Error) throw Object.assign(r, { code: r.message })
      return r
    }) as typeof server.api.client.call
    await user.type(box, "/deploy prod{Enter}")
    expect((box as HTMLTextAreaElement).value).toBe("/deploy prod")
    expect(box.getAttribute("aria-busy")).toBe("true")
    expect((screen.getByRole("button", { name: "Send" }) as HTMLButtonElement).disabled).toBe(true)
    act(() => answer(new Error("app_unreachable")))
    expect(await screen.findByText("Couldn't run /deploy: app_unreachable")).toBeTruthy()
    expect((box as HTMLTextAreaElement).value).toBe("/deploy prod")
    expect(box.getAttribute("aria-busy")).toBeNull()
    await user.type(box, "{Enter}")
    act(() => answer({ ok: true, delivered: "http" }))
    await waitFor(() => expect((box as HTMLTextAreaElement).value).toBe(""))
  })
})
