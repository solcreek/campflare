import {
  App,
  LogLevel,
  SocketModeReceiver,
  type BlockAction,
  type ButtonAction,
  type StaticSelectAction,
  type UsersSelectAction,
  type ViewClosedAction,
  type ViewSubmitAction,
} from "@slack/bolt"
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

/** A message with a select menu, a users select, and a button that opens a modal. */
const MENU_BLOCKS = [
  {
    type: "section",
    block_id: "pick",
    text: { type: "mrkdwn", text: "Which environment?" },
    accessory: {
      type: "static_select",
      action_id: "env",
      placeholder: { type: "plain_text", text: "Choose" },
      options: [
        { text: { type: "plain_text", text: "Production" }, value: "prod" },
        { text: { type: "plain_text", text: "Staging" }, value: "staging" },
      ],
    },
  },
  {
    type: "actions",
    block_id: "more",
    elements: [
      { type: "users_select", action_id: "who" },
      { type: "button", action_id: "open_form", text: { type: "plain_text", text: "Deploy…" } },
    ],
  },
]

const FORM_VIEW = {
  type: "modal" as const,
  callback_id: "deploy_form",
  notify_on_close: true,
  title: { type: "plain_text" as const, text: "Deploy" },
  submit: { type: "plain_text" as const, text: "Deploy" },
  blocks: [
    {
      type: "input",
      block_id: "note",
      label: { type: "plain_text" as const, text: "Release note" },
      element: { type: "plain_text_input", action_id: "text" },
    },
    {
      type: "input",
      block_id: "env",
      label: { type: "plain_text" as const, text: "Environment" },
      element: {
        type: "static_select",
        action_id: "pick",
        options: [
          { text: { type: "plain_text" as const, text: "Production" }, value: "prod" },
          { text: { type: "plain_text" as const, text: "Staging" }, value: "staging" },
        ],
      },
    },
  ],
}

/**
 * Wires a Bolt app as a real one would: selects answer by replacing the
 * message, the button opens a modal with the click's trigger_id, the modal's
 * submission is checked (errors for a short note) and then answered in the
 * channel, and its closing is noticed.
 */
function handleForms(bolt: App, seen: { actions: BlockAction[]; closed: ViewClosedAction[] }) {
  bolt.action<BlockAction<StaticSelectAction>>("env", async ({ ack, body, action, respond }) => {
    await ack()
    seen.actions.push(body)
    await respond({ replace_original: true, text: `Environment: ${action.selected_option.value}` })
  })
  bolt.action<BlockAction<UsersSelectAction>>("who", async ({ ack, body }) => {
    await ack()
    seen.actions.push(body)
  })
  bolt.action<BlockAction<ButtonAction>>("open_form", async ({ ack, body, client: web }) => {
    await ack()
    seen.actions.push(body)
    await web.views.open({ trigger_id: body.trigger_id, view: FORM_VIEW })
  })
  bolt.view<ViewSubmitAction>("deploy_form", async ({ ack, view, body, client: web }) => {
    const note = view.state.values.note!.text!.value ?? ""
    if (note.length < 5) {
      await ack({ response_action: "errors", errors: { note: "Say a bit more" } })
      return
    }
    await ack()
    const env = view.state.values.env!.pick!.selected_option!.value
    await web.chat.postMessage({ channel: general, text: `Deploying to ${env} for <@${body.user.id}>: ${note}` })
  })
  bolt.view<ViewClosedAction>({ callback_id: "deploy_form", type: "view_closed" }, async ({ ack, body }) => {
    await ack()
    seen.closed.push(body)
  })
}

type Views = { views: { id: string; callback_id: string }[]; errors?: Record<string, string> }

/** A users select, a modal opened, refused, submitted; another opened and closed; then a static select. */
async function formsThrough(app: CreatedApp, seen: { actions: BlockAction[]; closed: ViewClosedAction[] }) {
  const bot = client(app.bot_token)
  const posted = await bot.chat.postMessage({ channel: general, text: "Which environment?", blocks: MENU_BLOCKS })
  const act = (args: Record<string, string>) =>
    owner.apiCall("campflare.blocks.action", { channel: general, ts: posted.ts!, ...args })
  const me = (await owner.auth.test()).user_id!

  await act({ action_id: "who", value: me })
  const who = await until(() => seen.actions.find((b) => b.actions[0]?.action_id === "who"))
  expect(who.actions[0]).toMatchObject({ type: "users_select", selected_user: me })

  // The button opens the modal: it's there for the clicker by the time the click is acked, or soon after.
  await act({ action_id: "open_form" })
  const open = async () =>
    until(async () => {
      const { views } = (await owner.apiCall("campflare.views.list")) as unknown as Views
      return views.length > 0 ? views.at(-1) : undefined
    })
  const form = await open()
  expect(form.callback_id).toBe("deploy_form")
  const submit = async (values: unknown) =>
    (await owner.apiCall("campflare.views.submit", { view_id: form.id, values })) as unknown as Views
  const refused = await submit({ note: { text: "hi" }, env: { pick: "prod" } })
  expect(refused.errors).toEqual({ note: "Say a bit more" })
  expect(refused.views.map((v) => v.id)).toEqual([form.id])
  expect((await submit({ note: { text: "release 1.2 ✨ — größer" }, env: { pick: "prod" } })).views).toEqual([])
  await until(async () => {
    const latest = (await owner.conversations.history({ channel: general, limit: 1 })).messages?.[0]
    return latest?.text === `Deploying to prod for <@${me}>: release 1.2 ✨ — größer` ? latest : undefined
  })

  // Opened again and closed: the app hears of it (notify_on_close).
  await act({ action_id: "open_form" })
  const again = await open()
  await owner.apiCall("campflare.views.close", { view_id: again.id })
  const closed = await until(() => seen.closed[0])
  expect(closed).toMatchObject({ type: "view_closed", view: { id: again.id, callback_id: "deploy_form" } })

  // Last, as its answer replaces the message (and its menus) with text.
  await act({ action_id: "env", value: "staging" })
  const env = await until(() => seen.actions.find((b) => b.actions[0]?.action_id === "env"))
  expect(env.actions[0]).toMatchObject({ type: "static_select", selected_option: { value: "staging" } })
  expect(env.state).toEqual({
    values: {
      pick: { env: { type: "static_select", selected_option: expect.objectContaining({ value: "staging" }) } },
    },
  })
  await until(async () => ((await messageAt(posted.ts!))?.text === "Environment: staging" ? true : undefined))
}

describe("@slack/bolt modals and select menus", () => {
  it("over HTTP: app.action() on selects, views.open with the trigger_id, app.view() with response_action", async () => {
    const created = await createApp("Bolt Forms")
    const bolt = new App({
      token: created.bot_token,
      signingSecret: created.signing_secret,
      clientOptions: { slackApiUrl },
      logLevel: LogLevel.ERROR,
    })
    const seen = { actions: [] as BlockAction[], closed: [] as ViewClosedAction[] }
    handleForms(bolt, seen)
    const server = (await bolt.start(0)) as unknown as { address(): AddressInfo }
    try {
      await owner.apiCall("campflare.apps.setInteractivity", {
        app: created.app.id,
        request_url: `http://127.0.0.1:${server.address().port}/slack/events`,
      })
      await formsThrough(created, seen)
      expect(seen.actions.map((b) => b.actions[0]!.action_id)).toEqual(["who", "open_form", "open_form", "env"])
    } finally {
      await bolt.stop()
    }
  })

  it("over Socket Mode: the response_action comes in the ack", async () => {
    const created = await createApp("Socket Forms")
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
    const seen = { actions: [] as BlockAction[], closed: [] as ViewClosedAction[] }
    handleForms(bolt, seen)
    await bolt.start()
    try {
      await formsThrough(created, seen)
      expect(seen.actions.map((b) => b.actions[0]!.action_id)).toEqual(["who", "open_form", "open_form", "env"])
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
