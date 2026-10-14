// The app over plain W3C WebDriver (through tauri-driver): the protocol is a
// handful of JSON calls over fetch. e2e/run.ts starts the driver and passes
// WEBDRIVER_URL and CAMPFLARE_DESKTOP_APP.

import assert from "node:assert/strict"
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { test as nodeTest } from "node:test"

const base = process.env.WEBDRIVER_URL ?? "http://127.0.0.1:4444"
// W3C WebDriver's key for an element reference.
const ELEMENT = "element-6066-11e4-a52e-4f735466cecf"

/** A WebDriver command: POST with a JSON body, GET and DELETE without. */
async function call<T>(method: "GET" | "POST" | "DELETE", path: string, body?: unknown): Promise<T> {
  const res = await fetch(
    `${base}${path}`,
    method === "POST"
      ? { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body ?? {}) }
      : { method },
  )
  const json = (await res.json()) as { value: T & { error?: string; message?: string } }
  if (!res.ok) throw new Error(`${method} ${path}: ${json.value?.error} ${json.value?.message ?? ""}`)
  return json.value
}

/** The running app's WebDriver session; empty while it's closed. */
let session = ""

/**
 * Launches the app (a new process, with whatever it kept from the last launch),
 * with `args` as its command line: a campflare:// link, as Windows and Linux open one.
 */
export async function launch(args: string[] = []): Promise<void> {
  const application = process.env.CAMPFLARE_DESKTOP_APP
  assert.ok(application, "CAMPFLARE_DESKTOP_APP is not set: run the tests through e2e/run.ts")
  assert.equal(session, "", "the app is already running")
  // tauri-driver turns tauri:options into the platform driver's own (webkitgtk:browserOptions, ms:edgeOptions).
  const created = await call<{ sessionId: string }>("POST", "/session", {
    capabilities: { alwaysMatch: { "tauri:options": { application, args } } },
  })
  session = created.sessionId
  // The window loads the web app, React renders it and the workspace connects: let lookups wait for that.
  await call("POST", `/session/${session}/timeouts`, { implicit: 30_000 })
}

/** Closes the app; its keychain item, files and web storage stay for the next launch. */
export async function quit(): Promise<void> {
  if (!session) return
  const ending = session
  session = ""
  await call("DELETE", `/session/${ending}`)
}

const at = (path: string) => `/session/${session}${path}`

/** The first element the XPath matches, waiting up to the implicit timeout for one. */
export async function find(xpath: string): Promise<string> {
  const found = await call<Record<string, string>>("POST", at("/element"), { using: "xpath", value: xpath })
  const id = found?.[ELEMENT]
  if (!id) throw new Error(`no element for ${xpath}: ${JSON.stringify(found)}`)
  return id
}

export const text = (element: string) => call<string>("GET", at(`/element/${element}/text`))

export const attribute = (element: string, name: string) =>
  call<string | null>("GET", at(`/element/${element}/attribute/${name}`))

export const click = (element: string) => call("POST", at(`/element/${element}/click`))

/**
 * Puts text in an input or textarea as typing would end up, through the
 * native value setter and an input event, which React's onChange hears.
 * Typing key by key through the driver is less dependable for non-ASCII text.
 */
export const fill = (element: string, value: string) =>
  call("POST", at("/execute/sync"), {
    script: `const [el, value] = arguments
      const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
      Object.getOwnPropertyDescriptor(proto, "value").set.call(el, value)
      el.dispatchEvent(new Event("input", { bubbles: true }))`,
    args: [{ [ELEMENT]: element }, value],
  })

/** A test that, when it fails, leaves what the window showed in e2e/out/<name>.png and .html (CI uploads them). */
export function test(name: string, fn: () => Promise<void>, options: { skip?: boolean | string } = {}) {
  nodeTest(name, options, async () => {
    try {
      await fn()
    } catch (error) {
      if (session) {
        const out = join(import.meta.dirname, "out")
        mkdirSync(out, { recursive: true })
        const file = join(out, name.replace(/[^\w-]+/g, "-"))
        const [png, html] = await Promise.allSettled([
          call<string>("GET", at("/screenshot")),
          call<string>("GET", at("/source")),
        ])
        if (png.status === "fulfilled") writeFileSync(`${file}.png`, Buffer.from(png.value, "base64"))
        writeFileSync(`${file}.html`, html.status === "fulfilled" ? html.value : String(html.reason))
      }
      throw error
    }
  })
}
