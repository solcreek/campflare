import { App, isValidSlackRequest, LogLevel } from "@slack/bolt"
import { WebClient } from "@slack/web-api"
import { createServer, type IncomingHttpHeaders } from "node:http"
import type { AddressInfo } from "node:net"
import { beforeAll, describe, expect, inject, it } from "vitest"

// The Events API over HTTP: Campflare POSTs event_callbacks to an app's
// Request URL, and Bolt's HTTP receiver, unmodified, takes them.

const base = inject("baseUrl")
const slackApiUrl = `${base}/api/`
const client = (token: string) =>
  new WebClient(token, { slackApiUrl, logLevel: LogLevel.ERROR, retryConfig: { retries: 0 } })

let owner: WebClient
let general: string

interface CreatedApp {
  app: { id: string; bot_user_id: string }
  bot_token: string
  signing_secret: string
}

beforeAll(async () => {
  const boot = (await new WebClient(undefined, { slackApiUrl, logLevel: LogLevel.ERROR }).apiCall(
    "campflare.bootstrap",
    { secret: "conformance", team_name: `Events API ${Date.now()}`, user_name: "owner" },
  )) as unknown as { token: string; general_channel: string }
  owner = client(boot.token)
  general = boot.general_channel
})

const createApp = async (name: string) =>
  (await owner.apiCall("campflare.apps.create", { name })) as unknown as CreatedApp

async function until<T>(find: () => T | undefined, timeoutMs = 5000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const found = find()
    if (found !== undefined) return found
    if (Date.now() > deadline) throw new Error("timed out waiting")
    await new Promise((r) => setTimeout(r, 20))
  }
}

describe("@slack/bolt HTTP receiver", () => {
  it("passes url_verification and takes signed message and app_mention events", async () => {
    const created = await createApp("Bolt App")
    const bolt = new App({
      token: created.bot_token,
      signingSecret: created.signing_secret,
      clientOptions: { slackApiUrl },
      logLevel: LogLevel.ERROR,
    })
    const mentions: Record<string, unknown>[] = []
    const messages: Record<string, unknown>[] = []
    bolt.event("app_mention", async ({ event }) => void mentions.push(event as unknown as Record<string, unknown>))
    bolt.message(async ({ message }) => void messages.push(message as unknown as Record<string, unknown>))
    const server = (await bolt.start(0)) as unknown as { address(): AddressInfo }
    try {
      const url = `http://127.0.0.1:${server.address().port}/slack/events`
      const set = (await owner.apiCall("campflare.apps.setEventSubscriptions", {
        app: created.app.id,
        request_url: url,
      })) as unknown as { app: { event_subscriptions: { request_url: string } } }
      expect(set.app.event_subscriptions.request_url).toBe(url)

      const text = `<@${created.app.bot_user_id}> what's the plan?`
      const posted = await owner.chat.postMessage({ channel: general, text })
      const mention = await until(() => mentions.find((m) => m.ts === posted.ts))
      expect(mention).toMatchObject({ type: "app_mention", text, channel: general })
      expect(await until(() => messages.find((m) => m.ts === posted.ts))).toMatchObject({ text })
    } finally {
      await bolt.stop()
    }
  })
})

describe("retries", () => {
  it("retries a failed delivery with X-Slack-Retry-Num and X-Slack-Retry-Reason, signed afresh", async () => {
    const created = await createApp("Flaky App")
    const seen: { headers: IncomingHttpHeaders; body: Record<string, unknown>; valid: boolean }[] = []
    let failuresLeft = 1
    const server = createServer((req, res) => {
      let raw = ""
      req.on("data", (d: Buffer) => (raw += d))
      req.on("end", () => {
        const body = JSON.parse(raw) as Record<string, unknown>
        const valid = isValidSlackRequest({
          signingSecret: created.signing_secret,
          body: raw,
          headers: {
            "x-slack-signature": String(req.headers["x-slack-signature"]),
            "x-slack-request-timestamp": Number(req.headers["x-slack-request-timestamp"]),
          },
        })
        if (body.type === "url_verification") return res.end(String(body.challenge))
        seen.push({ headers: req.headers, body, valid })
        if (failuresLeft-- > 0) {
          res.statusCode = 500
          return res.end("not yet")
        }
        res.end()
      })
    })
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r))
    try {
      const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/events`
      await owner.apiCall("campflare.apps.setEventSubscriptions", { app: created.app.id, request_url: url })
      await owner.chat.postMessage({ channel: general, text: "retry me" })
      // The first retry comes a second after the failure.
      await until(() => (seen.length >= 2 ? true : undefined), 10_000)
      const [first, retry] = seen
      expect(first!.valid && retry!.valid).toBe(true)
      expect(first!.headers["x-slack-retry-num"]).toBeUndefined()
      expect(retry!.headers).toMatchObject({ "x-slack-retry-num": "1", "x-slack-retry-reason": "http_error" })
      expect(retry!.body.event_id).toBe(first!.body.event_id)
      expect(retry!.body).toMatchObject({ type: "event_callback", event: { text: "retry me" } })
    } finally {
      server.close()
    }
  })
})

describe("signing secret rotation", () => {
  it("leaves Bolt with the old secret refusing every request, and Bolt with the new one taking them", async () => {
    const created = await createApp("Rotated App")
    const rotated = (await owner.apiCall("campflare.apps.rotateSigningSecret", { app: created.app.id })) as unknown as {
      app: { signing_secret: string }
    }
    const secret = rotated.app.signing_secret
    expect(secret).not.toBe(created.signing_secret)

    const boltWith = async (signingSecret: string) => {
      const messages: Record<string, unknown>[] = []
      const bolt = new App({
        token: created.bot_token,
        signingSecret,
        clientOptions: { slackApiUrl },
        logLevel: LogLevel.ERROR,
      })
      bolt.message(async ({ message }) => void messages.push(message as unknown as Record<string, unknown>))
      const server = (await bolt.start(0)) as unknown as { address(): AddressInfo }
      return { bolt, messages, url: `http://127.0.0.1:${server.address().port}/slack/events` }
    }

    // The old secret: Bolt refuses the signed url_verification, so the URL isn't saved.
    const stale = await boltWith(created.signing_secret)
    try {
      await expect(
        owner.apiCall("campflare.apps.setEventSubscriptions", { app: created.app.id, request_url: stale.url }),
      ).rejects.toMatchObject({ data: { error: "url_verification_failed" } })
    } finally {
      await stale.bolt.stop()
    }

    const fresh = await boltWith(secret)
    try {
      await owner.apiCall("campflare.apps.setEventSubscriptions", { app: created.app.id, request_url: fresh.url })
      const posted = await owner.chat.postMessage({ channel: general, text: "signed with the new secret" })
      expect(await until(() => fresh.messages.find((m) => m.ts === posted.ts))).toMatchObject({
        text: "signed with the new secret",
      })
    } finally {
      await fresh.bolt.stop()
    }
  })
})
