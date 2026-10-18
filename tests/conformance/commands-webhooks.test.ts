import { App, LogLevel } from "@slack/bolt"
import { SocketModeClient } from "@slack/socket-mode"
import { WebClient } from "@slack/web-api"
import { IncomingWebhook } from "@slack/webhook"
import type { AddressInfo } from "node:net"
import { beforeAll, describe, expect, inject, it } from "vitest"

// Slash commands reach unmodified Slack SDKs (SocketModeClient over Socket
// Mode, Bolt's HTTP receiver), and the official IncomingWebhook posts.

const base = inject("baseUrl")
const slackApiUrl = `${base}/api/`
const client = (token: string) =>
  new WebClient(token, { slackApiUrl, logLevel: LogLevel.ERROR, retryConfig: { retries: 0 } })

let owner: WebClient
let general: string

interface CreatedApp {
  app: { id: string; bot_user_id: string }
  bot_token: string
  app_token: string
  signing_secret: string
}

beforeAll(async () => {
  const boot = (await new WebClient(undefined, { slackApiUrl, logLevel: LogLevel.ERROR }).apiCall(
    "campflare.bootstrap",
    { secret: "conformance", team_name: `Commands ${Date.now()}`, user_name: "owner" },
  )) as unknown as { token: string; general_channel: string }
  owner = client(boot.token)
  general = boot.general_channel
})

const createApp = async (name: string) =>
  (await owner.apiCall("campflare.apps.create", { name })) as unknown as CreatedApp

type Invoked = { delivered: string; response?: { response_type: string; text: string; ts: string } }

const invoke = async (command: string, text: string) =>
  (await owner.apiCall("campflare.commands.invoke", { channel: general, command, text })) as unknown as Invoked

async function latest() {
  return (await owner.conversations.history({ channel: general, limit: 1 })).messages?.[0]
}

describe("@slack/socket-mode", () => {
  it("receives slash_commands and acks with the answer", async () => {
    const created = await createApp("Socket Commands")
    await owner.apiCall("campflare.apps.setCommands", {
      app: created.app.id,
      commands: JSON.stringify([{ command: "/deploy", description: "Deploy a branch", usage_hint: "[branch]" }]),
    })
    const socket = new SocketModeClient({
      appToken: created.app_token,
      logLevel: LogLevel.ERROR,
      clientOptions: { slackApiUrl },
    })
    const seen: Record<string, string>[] = []
    socket.on(
      "slash_commands",
      async ({ body, ack }: { body: Record<string, string>; ack: (r?: Record<string, unknown>) => Promise<void> }) => {
        seen.push(body)
        await ack({ response_type: "in_channel", text: `Deploying ${body.text}` })
      },
    )
    await socket.start()
    try {
      const res = await invoke("/deploy", "staging")
      expect(res).toMatchObject({
        delivered: "socket",
        response: { response_type: "in_channel", text: "Deploying staging" },
      })
      expect(seen[0]).toMatchObject({
        command: "/deploy",
        text: "staging",
        channel_id: general,
        api_app_id: created.app.id,
      })
      expect((await latest())?.text).toBe("Deploying staging")
    } finally {
      await socket.disconnect()
    }
  })
})

describe("@slack/bolt HTTP receiver", () => {
  it("takes a command with app.command(), acks, answers through respond(), and opens a modal", async () => {
    const created = await createApp("Bolt Commands")
    const bolt = new App({
      token: created.bot_token,
      signingSecret: created.signing_secret,
      clientOptions: { slackApiUrl },
      logLevel: LogLevel.ERROR,
    })
    const opened: string[] = []
    bolt.command("/ship", async ({ ack, command, respond, client: web }) => {
      await ack(`Shipping ${command.text}…`)
      const view = await web.views.open({
        trigger_id: command.trigger_id,
        view: { type: "modal", title: { type: "plain_text", text: "Ship" }, blocks: [] },
      })
      opened.push(view.view!.id!)
      await respond({ response_type: "in_channel", text: `Shipped ${command.text} 🚀` })
    })
    const server = (await bolt.start(0)) as unknown as { address(): AddressInfo }
    try {
      await owner.apiCall("campflare.apps.setCommands", {
        app: created.app.id,
        commands: JSON.stringify([{ command: "/ship", url: `http://127.0.0.1:${server.address().port}/slack/events` }]),
      })
      const res = await invoke("/ship", "v2.0 — été")
      expect(res).toMatchObject({
        delivered: "http",
        response: { response_type: "ephemeral", text: "Shipping v2.0 — été…" },
      })
      const shipped = await until(async () => {
        const m = await latest()
        return m?.text === "Shipped v2.0 — été 🚀" ? m : undefined
      })
      expect(shipped.bot_id).toBeTruthy()
      expect(opened).toHaveLength(1)
    } finally {
      await bolt.stop()
    }
  })
})

describe("@slack/webhook", () => {
  it("posts through IncomingWebhook, and surfaces Slack's errors", async () => {
    const created = await createApp("Webhook Poster")
    const made = (await owner.apiCall("campflare.apps.createWebhook", {
      app: created.app.id,
      channel: general,
    })) as unknown as { webhook: { url: string } }
    const webhook = new IncomingWebhook(made.webhook.url)
    expect(await webhook.send({ text: "Nightly build 通過, tous verts" })).toEqual({ text: "ok" })
    expect(await latest()).toMatchObject({ text: "Nightly build 通過, tous verts", bot_id: expect.any(String) })
    await expect(webhook.send({ text: "" })).rejects.toMatchObject({
      code: "slack_webhook_http_error",
      statusCode: 400,
      body: "no_text",
    })
  })
})

async function until<T>(find: () => Promise<T | undefined> | T | undefined, timeoutMs = 5000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const found = await find()
    if (found !== undefined) return found
    if (Date.now() > deadline) throw new Error("timed out waiting")
    await new Promise((r) => setTimeout(r, 50))
  }
}
