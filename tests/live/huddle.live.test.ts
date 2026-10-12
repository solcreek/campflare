import { chromium, type Browser, type Page } from "playwright-core"
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest"
import { seed, type Seeded } from "../../scripts/seed.ts"
import { devVars } from "./env.ts"

// The /huddle page in real Chrome, with fake microphones and no cameras,
// against wrangler dev and the real Realtime SFU: two people join #general
// and each must receive the other's audio.

declare module "vitest" {
  export interface ProvidedContext {
    baseUrl: string
  }
}

const env = devVars()
const CHROME = env.CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
const configured = Boolean(env.REALTIME_APP_ID && env.REALTIME_APP_SECRET)

let browser: Browser
let base: string
let team: Seeded

beforeAll(async () => {
  if (!configured) return
  base = inject("baseUrl")
  team = await seed(base, "conformance", `Huddle ${Date.now()}`)
  browser = await chromium.launch({
    executablePath: CHROME,
    args: [
      "--use-fake-ui-for-media-stream",
      "--use-fake-device-for-media-stream",
      "--autoplay-policy=no-user-gesture-required",
    ],
  })
})
afterAll(async () => browser?.close())

async function joinAs(token: string): Promise<Page> {
  const page = await (await browser.newContext({ permissions: ["microphone"] })).newPage()
  page.on("pageerror", (e) => console.error("page error:", e.message))
  await page.goto(`${base}/huddle`)
  await page.fill("#token", token)
  await page.fill("#channel", "#general")
  await page.uncheck("#with-camera") // this test is about audio; huddle-video.live.test.ts does cameras
  await page.click("#join")
  await page.waitForFunction(() => document.querySelector("#status")?.textContent === "In the call.", undefined, {
    timeout: 30_000,
  })
  return page
}

/** Audio packets the page has received from the SFU so far. */
const received = (page: Page) =>
  page.evaluate(async () => {
    const pc = (window as unknown as { huddle?: { recv?: RTCPeerConnection } }).huddle?.recv
    if (!pc) return 0
    let n = 0
    for (const s of (await pc.getStats()).values())
      if (s.type === "inbound-rtp" && s.kind === "audio") n += s.packetsReceived ?? 0
    return n
  })

async function until(check: () => Promise<boolean>, ms = 20_000) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (await check()) return
    await new Promise((r) => setTimeout(r, 250))
  }
  throw new Error("timed out")
}

describe.skipIf(!configured)("huddle page (live)", () => {
  it("connects two people and carries audio both ways", async () => {
    const alex = await joinAs(team.owner)
    const vincent = await joinAs(team.people.vincent!)

    // Vincent subscribed to Alex on joining; Alex subscribed to Vincent on hearing huddle_joined.
    await until(async () => (await received(vincent)) > 50 && (await received(alex)) > 50)
    expect(await alex.locator(".tile").count()).toBe(2)
    expect(await vincent.locator(".tile").count()).toBe(2)
    expect(await vincent.locator("audio").count()).toBe(1)
    const stats = await alex.evaluate(() => (window as unknown as { huddleStats?: string[] }).huddleStats ?? [])
    expect(stats.join("\n")).toMatch(/send: connected/)
    console.log(`alex's view of the call:\n  ${stats.join("\n  ")}`)

    // Leaving shows up on the other side.
    await vincent.click("#leave")
    await alex.waitForFunction(() => document.querySelectorAll(".tile").length === 1, undefined, {
      timeout: 10_000,
    })
    expect(await vincent.locator("#status").textContent()).toBe("Not in a call.")
  })
})
