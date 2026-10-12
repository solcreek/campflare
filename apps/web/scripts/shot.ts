// pnpm --filter @campflare/web shot [route] [options]: look at the running dev app.
//
// Opens the app headless, waits for it to settle, saves a screenshot and prints
// what a human would notice and an agent can't see otherwise: console errors,
// failed requests, and the page's accessible outline.
//
//   shot '#/C123'                     a conversation (routes are URL hashes)
//   shot '#/C123' --as vincent        signed in as another seeded person
//   shot --dark --width 900           dark theme, narrower window
//   shot --out /tmp/a.png --url http://localhost:5199

import { chromium } from "@playwright/test"
import { parseArgs } from "node:util"

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    url: { type: "string", default: `http://localhost:${process.env.CAMPFLARE_WEB_PORT ?? 5173}` },
    as: { type: "string" },
    out: { type: "string", default: ".shots/shot.png" },
    width: { type: "string", default: "1280" },
    height: { type: "string", default: "800" },
    dark: { type: "boolean", default: false },
    wait: { type: "string", default: "1500", short: "w" },
  },
})

const route = positionals[0] ?? ""
const url = `${values.url}/${values.as ? `?as=${values.as}` : ""}${route}`
const browser = await chromium.launch()
const page = await browser.newPage({
  viewport: { width: Number(values.width), height: Number(values.height) },
  colorScheme: values.dark ? "dark" : "light",
})
const problems: string[] = []
page.on("console", (m) => {
  if (m.type() === "error" || m.type() === "warning") problems.push(`console.${m.type()}: ${m.text()}`)
})
page.on("pageerror", (e) => problems.push(`page error: ${e.message}`))
page.on("requestfailed", (r) => problems.push(`request failed: ${r.url()} (${r.failure()?.errorText})`))
page.on("response", (r) => {
  if (r.status() >= 400) problems.push(`HTTP ${r.status()}: ${r.url()}`)
})

await page.goto(url)
await page.waitForLoadState("networkidle").catch(() => {})
await page.waitForTimeout(Number(values.wait))
await page.screenshot({ path: values.out })
const outline = await page.locator("body").ariaSnapshot()
await browser.close()

console.log(`screenshot  ${values.out}  (${url})`)
console.log(problems.length ? `problems\n  ${problems.join("\n  ")}` : "problems    none")
console.log(`outline\n${outline}`)
