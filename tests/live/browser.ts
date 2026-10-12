import { chromium, type Browser, type Page } from "playwright-core"
import { devVars } from "./env.ts"

// Real Chrome, with a fake camera and microphone, for live tests that need a
// browser's WebRTC (simulcast encoders, getStats) rather than werift's.

export const CHROME = devVars().CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"

export function launchChrome(): Promise<Browser> {
  return chromium.launch({
    executablePath: CHROME,
    args: [
      "--use-fake-ui-for-media-stream",
      "--use-fake-device-for-media-stream",
      "--autoplay-policy=no-user-gesture-required",
    ],
  })
}

/** A page on a localhost origin (a secure context, so getUserMedia works), granted camera and microphone. */
export async function mediaPage(browser: Browser, url: string): Promise<Page> {
  const page = await (await browser.newContext({ permissions: ["microphone", "camera"] })).newPage()
  page.on("pageerror", (e) => console.error("page error:", e.message))
  await page.goto(url)
  return page
}

export async function until(check: () => Promise<boolean>, ms = 20_000) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (await check()) return
    await new Promise((r) => setTimeout(r, 250))
  }
  throw new Error("timed out")
}
