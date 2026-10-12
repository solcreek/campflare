import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { chromium, type Browser, type Page } from "playwright-core"
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest"
import { scribeTicket } from "../../apps/server/src/huddle/ticket.ts"
import { createSfu } from "../../apps/server/src/huddle/sfu.ts"
import { seed, type Seeded } from "../../scripts/seed.ts"
import { CHROME } from "./browser.ts"
import { devVars } from "./env.ts"
import { recordingFetch } from "./record.ts"
import { PHRASES, spoken } from "./voices.ts"
import { CLOUDFLARED, openTunnel } from "./tunnel.ts"

// The whole transcription path, live: two Chrome browsers whose fake
// microphones play speech (Alex in Spanish, Vincent in Japanese) join a call
// through a quick tunnel to wrangler dev; the SFU streams each microphone to
// the HuddleScribe over its WebSocket adapter; Whisper transcribes; the
// Huddle Scribe posts each line in the thread, attributed and labelled with
// its language. With RECORD_FIXTURES=1, real adapter responses are recorded.

const env = devVars()
const configured =
  Boolean(env.REALTIME_APP_ID && env.REALTIME_APP_SECRET && env.CF_ACCOUNT_ID && env.WORKERS_AI_TOKEN) &&
  Boolean(CLOUDFLARED)
const FIXTURES = resolve(import.meta.dirname, "../../apps/server/test/fixtures/sfu")
const es = PHRASES.find((p) => p.lang === "es")!
const ja = PHRASES.find((p) => p.lang === "ja")!

let tunnel: { url: string; close: () => void }
let team: Seeded
const browsers: Browser[] = []
let dir: string

beforeAll(async () => {
  if (!configured) return
  tunnel = await openTunnel(inject("baseUrl"))
  team = await seed(inject("baseUrl"), "conformance", `Transcribe ${Date.now()}`)
  dir = mkdtempSync(join(tmpdir(), "campflare-voices-"))
}, 120_000)
afterAll(async () => {
  for (const b of browsers) await b.close()
  tunnel?.close()
  if (dir) rmSync(dir, { recursive: true, force: true })
})

/** A browser whose microphone says `phrase` (Chrome loops the file), joined to #general through the tunnel. */
async function speaker(token: string, phrase: typeof es): Promise<Page> {
  const file = join(dir, `${phrase.lang}.wav`)
  writeFileSync(file, spoken(phrase, "LEI16@48000"))
  const browser = await chromium.launch({
    executablePath: CHROME,
    args: [
      "--use-fake-ui-for-media-stream",
      "--use-fake-device-for-media-stream",
      `--use-file-for-fake-audio-capture=${file}`,
    ],
  })
  browsers.push(browser)
  const page = await (await browser.newContext({ permissions: ["microphone"] })).newPage()
  page.on("pageerror", (e) => console.error("page error:", e.message))
  await page.goto(`${tunnel.url}/huddle`)
  await page.fill("#token", token)
  await page.fill("#channel", "#general")
  await page.uncheck("#with-camera")
  const logs: string[] = []
  page.on("console", (m) => logs.push(`${m.type()}: ${m.text()}`))
  await page.click("#join")
  try {
    await page.waitForFunction(() => document.querySelector("#status")?.textContent === "In the call.", undefined, {
      timeout: 45_000,
    })
  } catch {
    const status = await page.locator("#status").textContent()
    throw new Error(`${phrase.lang} speaker didn't join: "${status}"\n${logs.slice(-10).join("\n")}`)
  }
  return page
}

type Line = { user: string; text: string; language?: string }

/** The transcript lines a page shows. */
const lines = (page: Page) =>
  page.evaluate(() => [...document.querySelectorAll("#transcript li")].map((li) => li.textContent ?? ""))

describe.skipIf(!configured)("huddle transcription (live)", () => {
  it("posts who said what, in which language, as people speak", async () => {
    const alex = await speaker(team.owner, es)
    const vincent = await speaker(team.people.vincent!, ja)
    await alex.click("#transcribe")
    await alex.waitForFunction(
      () => document.querySelector("#transcribe")?.textContent === "Stop transcribing",
      undefined,
      { timeout: 30_000 },
    )

    // Lines arrive on every page as the Scribe posts them.
    const end = Date.now() + 90_000
    let seen: string[] = []
    while (Date.now() < end) {
      seen = await lines(vincent)
      if (seen.some((l) => es.expect.test(l)) && seen.some((l) => ja.expect.test(l))) break
      await new Promise((r) => setTimeout(r, 1000))
    }
    console.log(`transcript so far:\n  ${seen.slice(0, 6).join("\n  ")}`)
    expect(seen.some((l) => es.expect.test(l))).toBe(true)
    expect(seen.some((l) => ja.expect.test(l))).toBe(true)

    // And in the thread, with metadata naming the speaker and the language.
    const api = async <T>(method: string, args: Record<string, string>) =>
      (await (
        await fetch(`${tunnel.url}/api/${method}`, {
          method: "POST",
          headers: { authorization: `Bearer ${team.owner}` },
          body: new URLSearchParams(args),
        })
      ).json()) as T
    const history = await api<{ messages: { ts: string; text: string; reply_count?: number }[] }>(
      "conversations.history",
      { channel: team.channels.general! },
    )
    const parent = history.messages.find((m) => m.text.includes("Transcript of this call"))!
    const replies = await api<{ messages: { metadata?: { event_payload: Line } }[] }>("conversations.replies", {
      channel: team.channels.general!,
      ts: parent.ts,
    })
    const payloads = replies.messages.flatMap((m) => (m.metadata ? [m.metadata.event_payload] : []))
    const who = await api<{ user_id: string }>("auth.test", {})
    expect(payloads.some((p) => p.user === who.user_id && p.language === "es" && es.expect.test(p.text))).toBe(true)
    expect(payloads.some((p) => p.user !== who.user_id && p.language === "ja" && ja.expect.test(p.text))).toBe(true)

    // Stopping it: the Scribe summarises the call in the thread, and every page shows the summary.
    await alex.click("#transcribe")
    await vincent.waitForFunction(() => document.querySelector("#transcript li.summary") !== null, undefined, {
      timeout: 60_000,
    })
    const summaryText = await vincent.locator("#transcript li.summary").textContent()
    console.log(`summary:\n  ${summaryText}`)
    const after = await api<{
      messages: { metadata?: { event_type: string; event_payload: { lines: number; language?: string } } }[]
    }>("conversations.replies", { channel: team.channels.general!, ts: parent.ts })
    const summary = after.messages.find((m) => m.metadata?.event_type === "huddle_summary")
    expect(summary?.metadata?.event_payload.lines).toBeGreaterThanOrEqual(2)

    if (env.RECORD_FIXTURES) {
      // The adapter API's real answers: a stream to our endpoint, one to an endpoint that refuses the handshake, closing.
      const info = await api<{ participants: { user: string; session_id: string }[] }>("campflare.huddles.info", {
        channel: team.channels.general!,
      })
      const alexSeat = info.participants.find((p) => p.user === who.user_id)!
      const record: Parameters<typeof recordingFetch>[0] = []
      const sfu = createSfu({
        appId: env.REALTIME_APP_ID!,
        appSecret: env.REALTIME_APP_SECRET!,
        fetch: recordingFetch(record),
      })
      const wss = tunnel.url.replace(/^https/, "wss")
      const ticket = await scribeTicket("conformance", { teamId: "T0", channelId: "C0", user: who.user_id })
      const made = await sfu.streamToWebSocket([
        { sessionId: alexSeat.session_id, trackName: "audio", endpoint: `${wss}/huddle/scribe/${ticket}` },
        { sessionId: alexSeat.session_id, trackName: "audio", endpoint: `${wss}/huddle/scribe/not-a-ticket` },
      ])
      await sfu.closeAdapters(made.flatMap((m) => (m.adapterId ? [m.adapterId] : [])))
      await sfu
        .streamToWebSocket([
          { sessionId: alexSeat.session_id, trackName: "audio", endpoint: `${wss}/huddle/scribe/not-a-ticket` },
        ])
        .catch(() => undefined)
      mkdirSync(FIXTURES, { recursive: true })
      writeFileSync(
        join(FIXTURES, "exchanges-adapter.json"),
        `${JSON.stringify(record, null, 2).replaceAll(tunnel.url.replace(/^https:\/\//, ""), "tunnel.example.com")}\n`,
      )
    }
    await alex.click("#leave")
    await vincent.click("#leave")
  })
})
