// pnpm shot [route...] [options]: look at the running dev app.
//
// Opens the app headless, waits for it to settle, saves a screenshot and prints
// what a human would notice and an agent can't see otherwise: console errors,
// failed requests, and the page's accessible outline.
//
// It finds the app that `pnpm dev:all --web` is serving through its run file
// (scripts/dev-stack.ts): the repo's default stack, the one CAMPFLARE_DEV_ENV
// names, or --state <dir>. --url or CAMPFLARE_WEB_PORT point it elsewhere.
//
//   shot '#/C123'                     a conversation (routes are URL hashes)
//   shot 'http://localhost:8787/archives/C123/p1700000000000100'
//                                     a permalink: the screen it redirects to
//   shot '#/C123' '#/C456'            several, one screenshot each (shot.png, shot-2.png…)
//   shot '#/C123' --as vincent        signed in as another seeded person
//   shot --dark --width 900           dark theme, narrower window
//   shot --state /tmp/s/state         the stack of `pnpm dev:all --state /tmp/s/state --web`
//   shot '#/C123' --click 'textbox:Message' --type 'hi' --press Enter
//                                     steps, in order, on each route before the screenshot
//
// Exits 1 when there is no app to look at, the command line is wrong, or a
// step failed (the screenshot is still taken, and the problem listed).

import { chromium, type Page } from "@playwright/test"
import { resolve } from "node:path"
import {
  clickTarget,
  failedSteps,
  findApp,
  outFor,
  pageOptions,
  pageUrl,
  parseShotArgs,
  report,
  resolveRoute,
  stepProblem,
  UsageError,
  type ShotOptions,
  type Step,
} from "./shot-options.ts"

const root = resolve(import.meta.dirname, "../../..")
// pnpm runs this in apps/web; paths on the command line are relative to where it was typed.
const cwd = process.env.INIT_CWD ?? process.cwd()

async function run(page: Page, step: Step) {
  if (step.kind === "type") return page.keyboard.type(step.value)
  if (step.kind === "press") return page.keyboard.press(step.value)
  const { role, name } = clickTarget(step.value)
  const as = role as Parameters<Page["getByRole"]>[0]
  // The exact name if there is one ("dev" is not "Campflare Dev menu"), else a substring.
  const exact = page.getByRole(as, { name, exact: true })
  const target = (await exact.count()) ? exact : page.getByRole(as, { name })
  await target.first().click({ timeout: 5000 })
}

/** Shoots every route; returns the steps that failed. */
async function shoot(base: string, options: ShotOptions): Promise<string[]> {
  const failed: string[] = []
  // Permalinks become routes before a browser starts: a bad one fails fast.
  const hashes = await Promise.all(options.routes.map((route) => resolveRoute(route)))
  const browser = await chromium.launch()
  try {
    for (const [i, route] of options.routes.entries()) {
      const page = await browser.newPage(pageOptions(options))
      const problems: string[] = []
      page.on("console", (m) => {
        if (m.type() === "error" || m.type() === "warning") problems.push(`console.${m.type()}: ${m.text()}`)
      })
      page.on("pageerror", (e) => problems.push(`page error: ${e.message}`))
      page.on("requestfailed", (r) => problems.push(`request failed: ${r.url()} (${r.failure()?.errorText})`))
      page.on("response", (r) => {
        if (r.status() >= 400) problems.push(`HTTP ${r.status()}: ${r.url()}`)
      })

      const url = pageUrl(base, options.as, hashes[i]!)
      await page.goto(url)
      await page.waitForLoadState("networkidle").catch(() => {})
      await page.waitForTimeout(options.wait)
      for (const step of options.steps) {
        try {
          await run(page, step)
        } catch (error) {
          problems.push(stepProblem(step, error))
          failed.push(`${stepProblem(step, error)} (${route || "start"})`)
        }
      }
      if (options.steps.length) await page.waitForTimeout(500)
      const out = outFor(options.out, i)
      await page.screenshot({ path: out })
      const outline = await page.locator("body").ariaSnapshot()
      await page.close()

      console.log(report(i, { out, url, problems, outline }))
    }
  } finally {
    await browser.close()
  }
  return failed
}

// Errors set exitCode rather than process.exit, which cuts piped output short.
try {
  const options = parseShotArgs(process.argv.slice(2))
  const app = findApp(options, { root, cwd, env: process.env })
  if ("error" in app) {
    console.error(app.error)
    process.exitCode = 1
  } else {
    const failed = await shoot(app.url, options)
    if (failed.length) {
      console.error(failedSteps(failed))
      process.exitCode = 1
    }
  }
} catch (error) {
  if (!(error instanceof UsageError)) throw error
  console.error(
    `shot: ${error.message}\nUsage: pnpm shot [route...] [--as <handle>] [--dark] [--click role:name] [--type text] [--press key] …`,
  )
  process.exitCode = 1
}
