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
//   shot '#/C123' '#/C456'            several, one screenshot each (shot.png, shot-2.png…)
//   shot '#/C123' --as vincent        signed in as another seeded person
//   shot --dark --width 900           dark theme, narrower window
//   shot --state /tmp/s/state         the stack of `pnpm dev:all --state /tmp/s/state --web`
//   shot '#/C123' --click 'textbox:Message' --type 'hi' --press Enter
//                                     steps, in order, on each route before the screenshot

import { chromium, type Page } from "@playwright/test"
import { resolve } from "node:path"
import { parseArgs } from "node:util"
import { chooseStackFile, readStack } from "../../../scripts/dev-stack.ts"

const root = resolve(import.meta.dirname, "../../..")
// pnpm runs this in apps/web; paths on the command line are relative to where it was typed.
const cwd = process.env.INIT_CWD ?? process.cwd()

const { values, positionals, tokens } = parseArgs({
  allowPositionals: true,
  tokens: true,
  options: {
    url: { type: "string" },
    state: { type: "string" },
    as: { type: "string" },
    out: { type: "string", default: ".shots/shot.png" },
    width: { type: "string", default: "1280" },
    height: { type: "string", default: "800" },
    dark: { type: "boolean", default: false },
    wait: { type: "string", default: "1500", short: "w" },
    click: { type: "string", multiple: true },
    type: { type: "string", multiple: true },
    press: { type: "string", multiple: true },
  },
})

// Says why there is none and returns undefined (not process.exit: that cuts piped stderr short).
function appUrl(): string | undefined {
  if (values.url) return values.url.replace(/\/$/, "")
  if (process.env.CAMPFLARE_WEB_PORT) return `http://localhost:${process.env.CAMPFLARE_WEB_PORT}`
  const file = chooseStackFile(root, values.state && resolve(cwd, values.state), process.env.CAMPFLARE_DEV_ENV)
  const stack = readStack(file)
  if (!stack) {
    console.error(`No dev stack is running (no live ${file.replace(`${root}/`, "")}).
Start one:  pnpm dev:all --port 0 --web    (add --state <dir> for a separate one, then shot --state <dir>)
or point at an app:  pnpm shot --url http://localhost:<port>`)
    return undefined
  }
  if (!stack.appUrl) {
    console.error(`The dev stack on ${stack.apiUrl} (pid ${stack.pid}) runs without the app: restart it with --web.`)
    return undefined
  }
  return stack.appUrl
}

type Step = { kind: "click" | "type" | "press"; value: string }
const steps: Step[] = tokens.flatMap((t) =>
  t.kind === "option" && (t.name === "click" || t.name === "type" || t.name === "press") && t.value !== undefined
    ? [{ kind: t.name, value: t.value }]
    : [],
)

async function run(page: Page, step: Step) {
  if (step.kind === "type") return page.keyboard.type(step.value)
  if (step.kind === "press") return page.keyboard.press(step.value)
  const colon = step.value.indexOf(":")
  if (colon < 1) throw new Error(`--click wants "<role>:<accessible name>", e.g. "button:Send", not "${step.value}"`)
  const role = step.value.slice(0, colon) as Parameters<Page["getByRole"]>[0]
  const name = step.value.slice(colon + 1)
  // The exact name if there is one ("dev" is not "Campflare Dev menu"), else a substring.
  const exact = page.getByRole(role, { name, exact: true })
  const target = (await exact.count()) ? exact : page.getByRole(role, { name })
  await target.first().click({ timeout: 5000 })
}

/** shot.png, then shot-2.png, shot-3.png… for further routes. */
const outFor = (i: number) => (i === 0 ? values.out : values.out.replace(/(\.\w+)?$/, (ext) => `-${i + 1}${ext}`))

async function shoot(base: string) {
  const routes = positionals.length ? positionals : [""]

  const browser = await chromium.launch()
  try {
    for (const [i, route] of routes.entries()) {
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

      const url = `${base}/${values.as ? `?as=${values.as}` : ""}${route}`
      await page.goto(url)
      await page.waitForLoadState("networkidle").catch(() => {})
      await page.waitForTimeout(Number(values.wait))
      for (const step of steps) {
        try {
          await run(page, step)
        } catch (error) {
          problems.push(
            `--${step.kind} ${step.value}: ${error instanceof Error ? error.message.split("\n")[0] : error}`,
          )
        }
      }
      if (steps.length) await page.waitForTimeout(500)
      const out = outFor(i)
      await page.screenshot({ path: out })
      const outline = await page.locator("body").ariaSnapshot()
      await page.close()

      if (i > 0) console.log("")
      console.log(`screenshot  ${out}  (${url})`)
      console.log(problems.length ? `problems\n  ${problems.join("\n  ")}` : "problems    none")
      console.log(`outline\n${outline}`)
    }
  } finally {
    await browser.close()
  }
}

const base = appUrl()
if (base) await shoot(base)
else process.exitCode = 1
