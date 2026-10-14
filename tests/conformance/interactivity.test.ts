import { App, LogLevel, SocketModeReceiver, type BlockAction, type ButtonAction } from "@slack/bolt"
import { WebClient } from "@slack/web-api"
import type { AddressInfo } from "node:net"
import { beforeAll, describe, expect, inject, it } from "vitest"

// Interactivity: a person's click reaches an unmodified Bolt app as
// block_actions, over its HTTP receiver and over Socket Mode, and the app's
// respond() (the response_url) changes what people see.

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
    { secret: "conformance", team_name: `Interactivity ${Date.now()}`, user_name: "owner" },
  )) as unknown as { token: string; general_channel: string }
  owner = client(boot.token)
  general = boot.general_channel
})

const createApp = async (name: string) =>
  (await owner.apiCall("campflare.apps.create", { name })) as unknown as CreatedApp

async function until<T>(find: () => Promise<T | undefined> | T | undefined, timeoutMs = 5000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const found = await find()
    if (found !== undefined) return found
    if (Date.now() > deadline) throw new Error("timed out waiting")
    await new Promise((r) => setTimeout(r, 50))
  }
}

const BLOCKS = [
  { type: "section", text: { type: "mrkdwn", text: "Open the pull request?" } },
  {
    type: "actions",
    block_id: "decide",
    elements: [
      {
        type: "button",
        action_id: "approve",
        text: { type: "plain_text", text: "Approve" },
        value: "pr-42",
        style: "primary",
      },
    ],
  },
  {
    type: "context_actions",
    block_id: "rate",
    elements: [
      {
        type: "feedback_buttons",
        action_id: "feedback",
        positive_button: { text: { type: "plain_text", text: "Good" }, value: "up" },
        negative_button: { text: { type: "plain_text", text: "Bad" }, value: "down" },
      },
    ],
  },
]

/** The message as people see it now. */
async function messageAt(ts: string) {
  const res = await owner.conversations.history({ channel: general, latest: ts, inclusive: true, limit: 1 })
  return res.messages?.[0]
}

/** Wires a Bolt app's handlers: Approve replaces the message, feedback answers in the channel. */
function handle(bolt: App, seen: BlockAction[]) {
  bolt.action<BlockAction<ButtonAction>>("approve", async ({ ack, body, action, respond }) => {
    await ack()
    seen.push(body)
    await respond({ replace_original: true, text: `Approved ${action.value} by <@${body.user.id}>` })
  })
  bolt.action<BlockAction>("feedback", async ({ ack, body, respond }) => {
    await ack()
    seen.push(body)
    await respond({ response_type: "in_channel", replace_original: false, text: "Thanks for the feedback" })
  })
}

/** Feedback first (it leaves the message as it is), then Approve, which replaces it. */
async function clickThrough(app: CreatedApp, seen: BlockAction[], via: string) {
  const bot = client(app.bot_token)
  const posted = await bot.chat.postMessage({ channel: general, text: "Open the pull request?", blocks: BLOCKS })
  const click = async (args: Record<string, string>) =>
    (await owner.apiCall("campflare.blocks.action", { channel: general, ts: posted.ts!, ...args })) as unknown as {
      delivered: string
    }

  expect((await click({ action_id: "feedback", value: "up" })).delivered).toBe(via)
  const feedback = await until(() => seen.find((b) => b.actions[0]?.action_id === "feedback"))
  expect(feedback.actions[0]).toMatchObject({ type: "feedback_buttons", value: "up", text: { text: "Good" } })
  await until(async () => {
    const latest = (await owner.conversations.history({ channel: general, limit: 1 })).messages?.[0]
    return latest?.text === "Thanks for the feedback" ? latest : undefined
  })

  expect((await click({ action_id: "approve" })).delivered).toBe(via)
  const body = await until(() => seen.find((b) => b.actions[0]?.action_id === "approve"))
  expect(body).toMatchObject({
    type: "block_actions",
    api_app_id: app.app.id,
    channel: { id: general, name: "general" },
    container: { type: "message", message_ts: posted.ts, channel_id: general },
    message: { ts: posted.ts, bot_id: expect.any(String) },
    actions: [{ type: "button", action_id: "approve", block_id: "decide", value: "pr-42" }],
  })
  const replaced = await until(async () => {
    const m = await messageAt(posted.ts!)
    return m?.text?.startsWith("Approved") ? m : undefined
  })
  expect(replaced.text).toBe(`Approved pr-42 by <@${body.user.id}>`)
}

describe("@slack/bolt HTTP receiver", () => {
  it("takes a click with app.action(), acks, and answers through respond()", async () => {
    const created = await createApp("Bolt Buttons")
    const bolt = new App({
      token: created.bot_token,
      signingSecret: created.signing_secret,
      clientOptions: { slackApiUrl },
      logLevel: LogLevel.ERROR,
    })
    const seen: BlockAction[] = []
    handle(bolt, seen)
    const server = (await bolt.start(0)) as unknown as { address(): AddressInfo }
    try {
      await owner.apiCall("campflare.apps.setInteractivity", {
        app: created.app.id,
        request_url: `http://127.0.0.1:${server.address().port}/slack/events`,
      })
      await clickThrough(created, seen, "http")
      expect(seen.map((b) => b.actions[0]!.action_id)).toEqual(["feedback", "approve"])
    } finally {
      await bolt.stop()
    }
  })
})

describe("@slack/bolt Socket Mode receiver", () => {
  it("takes a click as an interactive envelope, acks, and answers through respond()", async () => {
    const created = await createApp("Socket Buttons")
    const receiver = new SocketModeReceiver({
      appToken: created.app_token,
      installerOptions: { clientOptions: { slackApiUrl } },
      logLevel: LogLevel.ERROR,
    })
    const bolt = new App({
      token: created.bot_token,
      receiver,
      clientOptions: { slackApiUrl },
      logLevel: LogLevel.ERROR,
    })
    const seen: BlockAction[] = []
    handle(bolt, seen)
    await bolt.start()
    try {
      await clickThrough(created, seen, "socket")
      expect(seen.map((b) => b.actions[0]!.action_id)).toEqual(["feedback", "approve"])
    } finally {
      await bolt.stop()
    }
  })
})
