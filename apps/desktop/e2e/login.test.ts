// The desktop app's first screen, through tauri-driver. Run by e2e/run.ts,
// which starts the driver and passes WEBDRIVER_URL and CAMPFLARE_DESKTOP_APP.
// Plain W3C WebDriver over fetch: the protocol is a handful of JSON calls.

import assert from "node:assert/strict"
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { after, before, test as nodeTest } from "node:test"

const base = process.env.WEBDRIVER_URL ?? "http://127.0.0.1:4444"
const application = process.env.CAMPFLARE_DESKTOP_APP
// W3C WebDriver's key for an element reference.
const ELEMENT = "element-6066-11e4-a52e-4f735466ecbf"

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

let session = ""

before(async () => {
  assert.ok(application, "CAMPFLARE_DESKTOP_APP is not set: run the tests through e2e/run.ts")
  // tauri-driver turns tauri:options into the platform driver's own (webkitgtk:browserOptions, ms:edgeOptions).
  const created = await call<{ sessionId: string }>("POST", "/session", {
    capabilities: { alwaysMatch: { "tauri:options": { application } } },
  })
  session = created.sessionId
  // The window loads the web app and React renders it: let element lookups wait for that.
  await call("POST", `/session/${session}/timeouts`, { implicit: 15_000 })
})

after(async () => {
  if (session) await call("DELETE", `/session/${session}`)
})

async function find(xpath: string): Promise<string> {
  const found = await call<Record<string, string>>("POST", `/session/${session}/element`, {
    using: "xpath",
    value: xpath,
  })
  const id = found?.[ELEMENT]
  if (!id) throw new Error(`no element for ${xpath}: ${JSON.stringify(found)}`)
  return id
}

/** A test that, when it fails, leaves what the window showed in e2e/out/<name>.png and .html (CI uploads them). */
function test(name: string, fn: () => Promise<void>) {
  nodeTest(name, async () => {
    try {
      await fn()
    } catch (error) {
      const out = join(import.meta.dirname, "out")
      mkdirSync(out, { recursive: true })
      const file = join(out, name.replace(/[^\w-]+/g, "-"))
      const [png, html] = await Promise.allSettled([
        call<string>("GET", `/session/${session}/screenshot`),
        call<string>("GET", `/session/${session}/source`),
      ])
      if (png.status === "fulfilled") writeFileSync(`${file}.png`, Buffer.from(png.value, "base64"))
      writeFileSync(`${file}.html`, html.status === "fulfilled" ? html.value : String(html.reason))
      throw error
    }
  })
}

const text = (element: string) => call<string>("GET", `/session/${session}/element/${element}/text`)

test("with no session, the app opens on the sign-in screen", async () => {
  assert.equal(await text(await find("//h1")), "Sign in to Campflare")
  // The Server and Token fields, by their labels.
  const server = await find("//label[span[normalize-space()='Server']]//input")
  const token = await find("//label[span[normalize-space()='Token']]//input")
  assert.equal(await call("GET", `/session/${session}/element/${token}/attribute/type`), "password")
  assert.ok(server)
  assert.equal(await text(await find("//button[@type='submit']")), "Sign in")
})
