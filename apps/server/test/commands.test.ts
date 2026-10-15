import { SELF } from "cloudflare:test"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
  call,
  connect,
  expectError,
  fakeRequestUrls,
  ok,
  settle,
  validSignature,
  workspace,
  type Body,
  type RequestUrlHit,
} from "./helpers"

// Slash commands: apps register them, people run them, the app answers as on Slack.

const URL = "https://app.example/commands"
let urls: ReturnType<typeof fakeRequestUrls>

beforeEach(() => {
  urls = fakeRequestUrls()
})
afterEach(() => urls.restore())

type Command = { command: string; description: string; usage_hint: string; app_id: string; url: string | null }

const DEPLOY = { command: "/deploy", description: "Deploy a branch", usage_hint: "[branch]", url: URL }

const isCommand = (h: RequestUrlHit) => typeof h.body?.command === "string"

/** A workspace with an app that has /deploy (POSTed to URL), and Bob, who runs it. */
async function setup({ url = URL as string | null } = {}) {
  const w = await workspace()
  const app = await w.addApp("Deployer")
  const bob = await w.addUser("bob")
  await ok("campflare.apps.setCommands", { app: app.id, commands: [{ ...DEPLOY, url }] }, w.owner.token, { json: true })
  const run = (args: Record<string, unknown> = {}, token = bob.token) =>
    call<{ delivered?: string; response?: Record<string, unknown> }>(
      "campflare.commands.invoke",
      { channel: w.general, command: "/deploy", text: "staging", ...args },
      token,
    )
  return { w, app, bob, run }
}

/** The app answers each command with this (JSON, or text as given). */
const answering = (body: unknown, status = 200) => {
  urls.answer = (hit) =>
    isCommand(hit)
      ? typeof body === "string"
        ? new Response(body, { status })
        : Response.json(body, { status })
      : new Response("")
}

async function respond(url: string, body: Record<string, unknown>) {
  const res = await SELF.fetch(
    new Request(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
  )
  return { status: res.status, body: (await res.json()) as Body }
}

describe("campflare.apps.setCommands", () => {
  it("replaces an app's commands, listed for everyone, and tells clients", async () => {
    const { w, app, bob } = await setup()
    const rtm = await connect((await ok<{ url: string }>("rtm.connect", {}, bob.token)).url)
    await rtm.next((f) => f.type === "hello")
    const set = await ok<{ commands: Command[] }>(
      "campflare.apps.setCommands",
      {
        app: app.id,
        commands: [
          DEPLOY,
          { command: "/部署", description: "デプロイする 배포" },
          { command: " /café ", description: "Prépare un café", usage_hint: "[taille]" },
        ],
      },
      w.owner.token,
      { json: true },
    )
    expect(set.commands.map((c) => c.command)).toEqual(["/deploy", "/部署", "/café"])
    await rtm.next((f) => f.type === "commands_changed")
    const listed = await ok<{ commands: (Command & { app_name: string })[] }>("campflare.commands.list", {}, bob.token)
    expect(listed.commands).toEqual([
      {
        command: "/café",
        description: "Prépare un café",
        usage_hint: "[taille]",
        app_id: app.id,
        app_name: "Deployer",
      },
      {
        command: "/deploy",
        description: "Deploy a branch",
        usage_hint: "[branch]",
        app_id: app.id,
        app_name: "Deployer",
      },
      {
        command: "/部署",
        description: "デプロイする 배포",
        usage_hint: "",
        app_id: app.id,
        app_name: "Deployer",
      },
    ])
    // Request URLs are the installer's to see (campflare.apps.info), not everyone's.
    const info = await ok<{ app: { commands: Command[] } }>("campflare.apps.info", { app: app.id }, w.owner.token)
    expect(info.app.commands.map((c) => [c.command, c.url])).toEqual([
      ["/café", null],
      ["/deploy", URL],
      ["/部署", null],
    ])
    // Empty clears them.
    await ok("campflare.apps.setCommands", { app: app.id, commands: "[]" }, w.owner.token)
    expect((await ok<{ commands: Command[] }>("campflare.commands.list", {}, bob.token)).commands).toEqual([])
    rtm.close()
  })

  it("refuses bad names, repeats and URLs, and someone else's app", async () => {
    const { w, app, bob } = await setup()
    for (const commands of [
      [{ command: "deploy" }],
      [{ command: "/Deploy" }],
      [{ command: "/two words" }],
      [{ command: `/${"x".repeat(32)}` }],
      [{ command: "/a" }, { command: "/a" }],
      [{ command: "/a", url: "http://app.example/x" }],
      [{ command: "/a", description: 5 }],
      [{ command: "/a", description: "x".repeat(201) }],
      { command: "/a" },
      ["/a"],
    ]) {
      await expectError("campflare.apps.setCommands", { app: app.id, commands }, w.owner.token, "invalid_arguments")
    }
    await expectError("campflare.apps.setCommands", { app: app.id, commands: [] }, bob.token, "not_allowed")
  })

  it("keeps a name to one app: command_taken, until that app's bot is deactivated", async () => {
    const { w, app } = await setup()
    const other = await w.addApp("Rival")
    const taken = await expectError(
      "campflare.apps.setCommands",
      { app: other.id, commands: JSON.stringify([{ command: "/deploy" }, { command: "/ship" }]) },
      w.owner.token,
      "command_taken",
    )
    expect(taken).toMatchObject({ response_metadata: { messages: ["[ERROR] /deploy belongs to another app"] } })
    // Nothing of the refused list was kept.
    expect((await ok<{ commands: Command[] }>("campflare.commands.list", {}, w.owner.token)).commands).toHaveLength(1)
    await ok("campflare.users.deactivate", { user: app.botUserId }, w.owner.token)
    expect((await ok<{ commands: Command[] }>("campflare.commands.list", {}, w.owner.token)).commands).toEqual([])
    await ok("campflare.apps.setCommands", { app: other.id, commands: [{ command: "/deploy" }] }, w.owner.token, {
      json: true,
    })
    const listed = await ok<{ commands: Command[] }>("campflare.commands.list", {}, w.owner.token)
    expect(listed.commands.map((c) => [c.command, c.app_id])).toEqual([["/deploy", other.id]])
  })

  it("is the app's own to call with its bot token (commands scope)", async () => {
    const w = await workspace()
    const app = await w.addApp("Agent")
    const other = await w.addApp("Other")
    const set = await ok<{ app_id: string; commands: Command[] }>(
      "campflare.apps.setCommands",
      { commands: [{ command: "/ask", usage_hint: "[question]" }] },
      app.botToken,
      { json: true },
    )
    expect(set).toMatchObject({ app_id: app.id, commands: [{ command: "/ask", usage_hint: "[question]" }] })
    await expectError("campflare.apps.setCommands", { app: other.id, commands: [] }, app.botToken, "app_not_found")
    // A person's token without apps:write can't.
    const writer = (await ok<{ token: string }>("campflare.tokens.create", { preset: "write" }, w.owner.token)).token
    await expectError("campflare.apps.setCommands", { app: app.id, commands: [] }, writer, "missing_scope")
  })
})

describe("campflare.commands.invoke over HTTP", () => {
  it("POSTs Slack's form fields, signed, to the command's Request URL", async () => {
    const { w, app, bob, run } = await setup()
    expect(await run({ text: "  feature/本番-déploiement " })).toEqual({ ok: true, delivered: "http" })
    const hit = await urls.next(isCommand)
    expect(hit.url).toBe(URL)
    expect(hit.headers.get("content-type")).toBe("application/x-www-form-urlencoded")
    expect(await validSignature(hit, app.signingSecret)).toBe(true)
    expect(hit.body).toEqual({
      token: "",
      team_id: w.teamId,
      team_domain: expect.any(String),
      channel_id: w.general,
      channel_name: "general",
      user_id: bob.id,
      user_name: "bob",
      command: "/deploy",
      text: "feature/本番-déploiement",
      api_app_id: app.id,
      is_enterprise_install: "false",
      response_url: expect.stringMatching(/^https:\/\/campflare\.test\/actions\//),
      trigger_id: expect.stringMatching(/^\d+\.\d+\.[0-9a-f]+$/),
    })
  })

  it("shows a JSON answer to the invoker alone, as the app's bot", async () => {
    const { w, app, bob, run } = await setup()
    const mine = await connect((await ok<{ url: string }>("rtm.connect", {}, bob.token)).url)
    const owners = await connect((await ok<{ url: string }>("rtm.connect", {}, w.owner.token)).url)
    await mine.next((f) => f.type === "hello")
    await owners.next((f) => f.type === "hello")
    const blocks = [{ type: "section", block_id: "b", text: { type: "mrkdwn", text: "Deploying *staging*" } }]
    answering({ text: "Deploying staging", blocks })
    const res = await run()
    expect(res).toEqual({
      ok: true,
      delivered: "http",
      response: { response_type: "ephemeral", text: "Deploying staging", blocks, ts: expect.any(String) },
    })
    const shown = await mine.next((f) => f.subtype === "ephemeral")
    expect(shown).toMatchObject({ user_id: app.botUserId, app_id: app.id, text: "Deploying staging", blocks })
    await settle(100)
    expect(owners.frames.filter((f) => f.subtype === "ephemeral")).toEqual([])
    mine.close()
    owners.close()
  })

  it("posts an in_channel answer in the conversation, and takes plain text as an ephemeral answer", async () => {
    const { w, app, run } = await setup()
    answering({ response_type: "in_channel", text: "Deployed staging ✅" })
    const res = await run()
    expect(res.response).toMatchObject({ response_type: "in_channel", text: "Deployed staging ✅" })
    const history = await ok<{ messages: { text: string; bot_id?: string; ts: string }[] }>(
      "conversations.history",
      { channel: w.general, limit: 1 },
      w.owner.token,
    )
    expect(history.messages[0]).toMatchObject({ text: "Deployed staging ✅", bot_id: app.botId, ts: res.response!.ts })
    answering("Working on it")
    expect((await run()).response).toMatchObject({ response_type: "ephemeral", text: "Working on it" })
    // An empty answer, or one that says nothing, shows nothing.
    answering({ response_type: "in_channel" })
    expect(await run()).toEqual({ ok: true, delivered: "http" })
  })

  it("is dispatch_failed when the URL errs, app_unreachable when there's nowhere to send it", async () => {
    const { run } = await setup()
    answering("nope", 500)
    expect(await run()).toMatchObject({
      ok: false,
      error: "dispatch_failed",
      response_metadata: { messages: ["[ERROR] the command's Request URL answered 500"] },
    })
    answering("{broken")
    expect((await run()).error).toBe("dispatch_failed")
    urls.answer = () => {
      throw new TypeError("connection refused")
    }
    expect((await run()).error).toBe("app_unreachable")
    const nowhere = await setup({ url: null })
    expect(await nowhere.run()).toMatchObject({
      error: "app_unreachable",
      response_metadata: {
        messages: [
          "[ERROR] the app didn't take it: it has no Socket Mode connection and the command has no Request URL",
        ],
      },
    })
  })

  it("wants a command that exists, a conversation the person can post in, and chat:write", async () => {
    const { w, app, bob, run } = await setup()
    expect((await run({ command: "/nope" })).error).toBe("command_not_found")
    expect((await run({ command: "" })).error).toBe("command_not_found")
    const secret = await ok<{ channel: { id: string } }>(
      "conversations.create",
      { name: "secret", is_private: true },
      w.owner.token,
    )
    expect((await run({ channel: secret.channel.id })).error).toBe("channel_not_found")
    const open = await ok<{ channel: { id: string } }>("conversations.create", { name: "open" }, w.owner.token)
    expect((await run({ channel: open.channel.id })).error).toBe("not_in_channel")
    await ok("conversations.archive", { channel: open.channel.id }, w.owner.token)
    expect((await run({ channel: open.channel.id }, w.owner.token)).error).toBe("is_archived")
    const reader = (await ok<{ token: string }>("campflare.tokens.create", { preset: "read" }, bob.token)).token
    expect((await run({}, reader)).error).toBe("missing_scope")
    // Bots don't run commands.
    expect((await run({}, app.botToken)).error).toBe("not_allowed_token_type")
    // A deactivated app's command is gone.
    await ok("campflare.users.deactivate", { user: app.botUserId }, w.owner.token)
    expect((await run()).error).toBe("command_not_found")
    expect(urls.hits.filter(isCommand)).toEqual([])
  })

  it("runs in a DM, named directmessage", async () => {
    const { w, bob, run } = await setup()
    const dm = await ok<{ channel: { id: string } }>("conversations.open", { users: w.owner.id }, bob.token)
    await ok("chat.postMessage", { channel: dm.channel.id, text: "hi" }, bob.token)
    expect((await run({ channel: dm.channel.id })).ok).toBe(true)
    expect((await urls.next(isCommand)).body).toMatchObject({
      channel_id: dm.channel.id,
      channel_name: "directmessage",
    })
  })
})

describe("a command's response_url", () => {
  it("posts in the conversation or to the invoker, five times", async () => {
    const { w, app, bob, run } = await setup()
    const rtm = await connect((await ok<{ url: string }>("rtm.connect", {}, bob.token)).url)
    await rtm.next((f) => f.type === "hello")
    await run()
    const url = (await urls.next(isCommand)).body.response_url as string
    expect(await respond(url, { response_type: "in_channel", text: "Done: staging は完了" })).toEqual({
      status: 200,
      body: { ok: true },
    })
    const history = await ok<{ messages: { text: string; bot_id?: string }[] }>(
      "conversations.history",
      { channel: w.general, limit: 1 },
      w.owner.token,
    )
    expect(history.messages[0]).toMatchObject({ text: "Done: staging は完了", bot_id: app.botId })
    await respond(url, { text: "Only you see this" })
    expect(await rtm.next((f) => f.subtype === "ephemeral")).toMatchObject({ text: "Only you see this" })
    // There is no original message to replace (a new one, then) or delete.
    expect((await respond(url, { replace_original: true, text: "Remplacé" })).status).toBe(200)
    expect(await rtm.next((f) => f.subtype === "ephemeral")).toMatchObject({ text: "Remplacé" })
    expect(await respond(url, { delete_original: true })).toEqual({
      status: 400,
      body: { ok: false, error: "message_not_found" },
    })
    expect((await respond(url, { text: "fifth" })).status).toBe(200)
    expect(await respond(url, { text: "sixth" })).toEqual({ status: 404, body: { ok: false, error: "used_url" } })
    rtm.close()
  })

  it("comes with a trigger_id that opens a modal for the invoker", async () => {
    const { app, bob, run } = await setup()
    await run()
    const trigger_id = (await urls.next(isCommand)).body.trigger_id as string
    const view = {
      type: "modal",
      title: { type: "plain_text", text: "Deploy" },
      blocks: [{ type: "section", text: { type: "mrkdwn", text: "Which branch?" } }],
    }
    await ok("views.open", { trigger_id, view }, app.botToken, { json: true })
    const views = await ok<{ views: { title: { text: string } }[] }>("campflare.views.list", {}, bob.token)
    expect(views.views.map((v) => v.title.text)).toEqual(["Deploy"])
  })
})

describe("campflare.commands.invoke over Socket Mode", () => {
  it("sends a slash_commands envelope, and the ack's payload is the answer", async () => {
    const { w, app, run } = await setup()
    const link = await connect((await ok<{ url: string }>("apps.connections.open", {}, app.appToken)).url)
    await link.next((f) => f.type === "hello")
    link.ws.addEventListener("message", (e: MessageEvent) => {
      const frame = JSON.parse(String(e.data)) as { type: string; envelope_id: string }
      if (frame.type === "slash_commands") {
        link.ws.send(
          JSON.stringify({
            envelope_id: frame.envelope_id,
            payload: { response_type: "in_channel", text: "Deploying from the socket" },
          }),
        )
      }
    })
    const res = await run()
    expect(res).toMatchObject({ ok: true, delivered: "socket", response: { response_type: "in_channel" } })
    const envelope = await link.next((f) => f.type === "slash_commands")
    expect(envelope).toEqual({
      envelope_id: expect.any(String),
      type: "slash_commands",
      accepts_response_payload: true,
      payload: expect.objectContaining({ command: "/deploy", text: "staging", channel_id: w.general }),
    })
    expect(urls.hits).toEqual([])
    link.close()
  })

  it("takes a plain ack, and a string payload as text", async () => {
    const { app, run } = await setup({ url: null })
    const link = await connect((await ok<{ url: string }>("apps.connections.open", {}, app.appToken)).url)
    await link.next((f) => f.type === "hello")
    let payload: unknown
    link.ws.addEventListener("message", (e: MessageEvent) => {
      const frame = JSON.parse(String(e.data)) as { type: string; envelope_id: string }
      if (frame.type === "slash_commands") link.ws.send(JSON.stringify({ envelope_id: frame.envelope_id, payload }))
    })
    expect(await run()).toEqual({ ok: true, delivered: "socket" })
    payload = "Got it"
    expect((await run()).response).toMatchObject({ response_type: "ephemeral", text: "Got it" })
    link.close()
  })

  it("is app_unreachable when the app doesn't ack in time", async () => {
    const { app, run } = await setup()
    const link = await connect((await ok<{ url: string }>("apps.connections.open", {}, app.appToken)).url)
    await link.next((f) => f.type === "hello")
    expect((await run()).error).toBe("app_unreachable")
    // Not POSTed instead: the link was there.
    expect(urls.hits).toEqual([])
    link.close()
  }, 10_000)
})
