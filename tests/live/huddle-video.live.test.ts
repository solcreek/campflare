import type { Browser, Page } from "playwright-core"
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest"
import { seed, type Seeded } from "../../scripts/seed.ts"
import { launchChrome, mediaPage, until } from "./browser.ts"
import { devVars } from "./env.ts"

// Four people with cameras in one call, in real Chrome against the real SFU:
// everyone receives everyone, video layers follow the page's policy, and a
// camera turned off and on again shows on the others' screens.

const env = devVars()
const configured = Boolean(env.REALTIME_APP_ID && env.REALTIME_APP_SECRET)

type Video = { user: string; rid?: string; width: number; frames: number }

let browser: Browser
let base: string
let team: Seeded

beforeAll(async () => {
  if (!configured) return
  base = inject("baseUrl")
  team = await seed(base, "conformance", `Video ${Date.now()}`)
  browser = await launchChrome()
})
afterAll(async () => browser?.close())

async function joinAs(token: string): Promise<Page> {
  const page = await mediaPage(browser, `${base}/huddle`)
  await page.fill("#token", token)
  await page.fill("#channel", "#general")
  await page.click("#join")
  await page.waitForFunction(() => document.querySelector("#status")?.textContent === "In the call.", undefined, {
    timeout: 30_000,
  })
  return page
}

const videos = (page: Page) => page.evaluate(() => (window as unknown as { huddleVideo?: Video[] }).huddleVideo ?? [])
const me = (page: Page) => page.evaluate(() => (window as unknown as { huddle: { me: string } }).huddle.me)

/** Each user this page is decoding video from, at a width above zero and with frames still arriving. */
async function seeing(page: Page): Promise<Map<string, Video>> {
  const first = new Map((await videos(page)).map((v) => [v.user, v]))
  await new Promise((r) => setTimeout(r, 1200))
  const live = new Map<string, Video>()
  for (const v of await videos(page))
    if (v.width > 0 && v.frames > (first.get(v.user)?.frames ?? 0)) live.set(v.user, v)
  return live
}

/** What each page has: for the failure message when a wait times out. */
async function diagnose(pages: Page[]) {
  return Promise.all(
    pages.map((page) =>
      page.evaluate(() => {
        const w = window as unknown as {
          huddle?: { me: string; subs: Map<string, unknown>; recvSession: string }
          huddleVideo?: unknown
          huddleStats?: unknown
        }
        return {
          me: w.huddle?.me,
          status: document.querySelector("#status")?.textContent,
          subs: w.huddle ? [...w.huddle.subs.values()] : [],
          video: w.huddleVideo,
          stats: w.huddleStats,
        }
      }),
    ),
  )
}

async function waitOrExplain(pages: Page[], check: () => Promise<boolean>, ms: number, what: string) {
  try {
    await until(check, ms)
  } catch {
    throw new Error(`timed out waiting for ${what}:\n${JSON.stringify(await diagnose(pages), null, 1)}`)
  }
}

describe.skipIf(!configured)("video huddle (live)", () => {
  it("connects four people with cameras, at the layers the page asks for", async () => {
    const tokens = [team.owner, team.people.vincent!, team.people.minjun!, team.people.ada!]
    const pages: Page[] = []
    for (const token of tokens) pages.push(await joinAs(token))
    const ids = await Promise.all(pages.map(me))

    // Everyone decodes the other three cameras. The checks below read the sample that showed it:
    // sampling again can catch a tile between layers (the speaker's steps up), waiting for a keyframe.
    let views: Map<string, Video>[] = []
    await waitOrExplain(
      pages,
      async () => (views = await Promise.all(pages.map(seeing))).every((m) => m.size === 3),
      45_000,
      "everyone to see three cameras",
    )
    for (const [i, view] of views.entries())
      expect([...view.keys()].toSorted()).toEqual(ids.filter((_, j) => j !== i).toSorted())
    expect(await pages[0]!.locator("audio").count()).toBe(3)

    // Three tiles each: half resolution for most, a step up for the speaker.
    const all = views.flatMap((v) => [...v.values()])
    expect(all.every((v) => v.rid === "h" || v.rid === "f")).toBe(true)
    expect(all.some((v) => v.rid === "h" && v.width <= 700)).toBe(true)
    console.log(`received: ${all.map((v) => `${v.rid} ${v.width}px`).join(", ")}`)

    // Alex turns the camera off: the others stop decoding Alex's video.
    await pages[0]!.click("#camera")
    await waitOrExplain(
      pages,
      async () => (await Promise.all(pages.slice(1).map(seeing))).every((m) => !m.has(ids[0]!)),
      20_000,
      "Alex's camera to stop",
    )
    // And on again, as a new track: the others decode it again.
    await pages[0]!.click("#camera")
    await waitOrExplain(
      pages,
      async () => (await Promise.all(pages.slice(1).map(seeing))).every((m) => m.has(ids[0]!)),
      30_000,
      "Alex's camera to come back",
    )

    for (const page of pages) await page.click("#leave")
  })
})
