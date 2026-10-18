import { afterEach, describe, expect, it } from "vitest"
import { commandIn, commandSuggestions, initialState, reduce, type SlashCommand } from "../src/index"
import { createWorkspace } from "../src/workspace"
import { fakeApi, FakeSocket, settle, type Handler } from "../src/testing"

afterEach(() => {
  FakeSocket.all = []
})

const cmd = (command: string, app_name = "Deployer"): SlashCommand => ({
  command,
  description: `${command} things`,
  usage_hint: "",
  app_id: "A1",
  app_name,
})

const COMMANDS = [cmd("/deploy"), cmd("/部署"), cmd("/café"), cmd("/debug")]

describe("commandIn", () => {
  it("finds a registered command and the text after it", () => {
    expect(commandIn("/deploy staging now", COMMANDS)).toEqual({ command: "/deploy", text: "staging now" })
    expect(commandIn("  /Deploy  ", COMMANDS)).toEqual({ command: "/deploy", text: "" })
    expect(commandIn("/部署 本番\nsecond line", COMMANDS)).toEqual({ command: "/部署", text: "本番\nsecond line" })
    expect(commandIn("/café grand", COMMANDS)).toEqual({ command: "/café", text: "grand" })
    // Decomposed (e + U+0301) is the same name.
    expect(commandIn("/cafe\u0301 grand", COMMANDS)).toEqual({ command: "/café", text: "grand" })
    expect(commandSuggestions("/cafe\u0301", COMMANDS).map((c) => c.command)).toEqual(["/café"])
  })

  it("leaves anything else a message", () => {
    expect(commandIn("/shrug ¯\\_(ツ)_/¯", COMMANDS)).toBeUndefined()
    expect(commandIn("deploy staging", COMMANDS)).toBeUndefined()
    expect(commandIn("/", COMMANDS)).toBeUndefined()
    expect(commandIn("see /deploy", COMMANDS)).toBeUndefined()
    expect(commandIn("/deploy", [])).toBeUndefined()
  })
})

describe("commandSuggestions", () => {
  it("offers the commands starting with what's typed, until a space", () => {
    expect(commandSuggestions("/", COMMANDS).map((c) => c.command)).toEqual(["/café", "/debug", "/deploy", "/部署"])
    expect(commandSuggestions("/de", COMMANDS).map((c) => c.command)).toEqual(["/debug", "/deploy"])
    expect(commandSuggestions("/DEP", COMMANDS).map((c) => c.command)).toEqual(["/deploy"])
    expect(commandSuggestions("/部", COMMANDS).map((c) => c.command)).toEqual(["/部署"])
    expect(commandSuggestions("/deploy ", COMMANDS)).toEqual([])
    expect(commandSuggestions("hi", COMMANDS)).toEqual([])
    expect(commandSuggestions("/x", COMMANDS)).toEqual([])
  })
})

describe("the workspace's commands", () => {
  it("are a state slice", () => {
    expect(reduce(initialState, { type: "commands", commands: COMMANDS }).commands).toBe(COMMANDS)
  })

  const base: Record<string, Handler> = {
    "auth.test": () => ({ user_id: "U1", team_id: "T1", team: "Team" }),
    "users.list": () => ({ members: [] }),
    "conversations.list": () => ({ channels: [] }),
    "rtm.connect": () => ({ url: "wss://rtm" }),
  }

  it("load at the start, reload on commands_changed, and run with invokeCommand", async () => {
    let listed = [cmd("/deploy")]
    const api = fakeApi({
      ...base,
      "campflare.commands.list": () => ({ commands: listed }),
      "campflare.commands.invoke": (args) =>
        args.command === "/deploy"
          ? {
              delivered: "http",
              response: { response_type: "ephemeral", text: `Deploying ${args.text}`, ts: "1.000001" },
            }
          : args.command === "/quiet"
            ? { delivered: "socket" }
            : new Error("command_not_found"),
    })
    const ws = createWorkspace({
      client: api.client,
      WebSocket: FakeSocket as unknown as typeof WebSocket,
      minDelayMs: 1,
    })
    await ws.start()
    await settle()
    expect(ws.getState().commands.map((c) => c.command)).toEqual(["/deploy"])
    listed = [cmd("/deploy"), cmd("/quiet")]
    FakeSocket.all[0]!.receive({ type: "hello" })
    FakeSocket.all[0]!.receive({ type: "commands_changed", event_ts: "1.0" })
    await settle()
    expect(ws.getState().commands.map((c) => c.command)).toEqual(["/deploy", "/quiet"])

    expect(await ws.invokeCommand("C1", "/deploy", "staging")).toEqual({
      response_type: "ephemeral",
      text: "Deploying staging",
      ts: "1.000001",
    })
    expect(api.calls.at(-1)).toEqual({
      method: "campflare.commands.invoke",
      args: { channel: "C1", command: "/deploy", text: "staging" },
    })
    expect(await ws.invokeCommand("C1", "/quiet", "")).toBeUndefined()
    await expect(ws.invokeCommand("C1", "/gone", "")).rejects.toMatchObject({ code: "command_not_found" })
    ws.stop()
  })

  it("stay empty when the server has none to list", async () => {
    const ws = createWorkspace({ client: fakeApi(base).client, realtime: "none" })
    await ws.start()
    await settle()
    expect(ws.getState().commands).toEqual([])
  })
})
