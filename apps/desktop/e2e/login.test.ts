// The desktop app signing in, through tauri-driver: run by e2e/run.ts, which
// also starts a fresh, seeded server (CAMPFLARE_E2E_STACK) and gives the app a
// config directory of its own (CAMPFLARE_DESKTOP_CONFIG). The tests run in
// order and share the app's state: signed out, signed in, restarted, signed out.

import assert from "node:assert/strict"
import { existsSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"
import { after, before } from "node:test"
import { attribute, click, fill, find, launch, quit, test, text } from "./driver.ts"

interface Stack {
  apiUrl: string
  /** A seeded person's user token. */
  token: string
  /** #general's id. */
  general: string
}

const stack = JSON.parse(process.env.CAMPFLARE_E2E_STACK ?? "null") as Stack | null
/** Where the session file goes when there is no keychain. */
const sessionFile = process.env.CAMPFLARE_DESKTOP_CONFIG
  ? join(process.env.CAMPFLARE_DESKTOP_CONFIG, "session.json")
  : undefined
/** CI has no Secret Service, so the session must land in the file there; elsewhere either will do. */
const expectFile = process.env.CAMPFLARE_E2E_SESSION === "file"

// Unique per run, in every script: a server kept between runs must not find an earlier copy.
const run = Date.now().toString(36)
const message = `早安 · こんにちは · 안녕하세요 · ¿Qué tal? Ça va. Grüße ${run}`

const CONNECTED = "//*[@role='status' and @aria-label='Connected']"
const SIGN_IN = "//h1[normalize-space()='Sign in to Campflare']"
const ourMessage = `//*[@role='log' and @aria-label='Messages']//article[contains(., '${run}')]`

async function until(what: string, check: () => boolean | Promise<boolean>, ms = 15_000): Promise<void> {
  for (const end = Date.now() + ms; !(await check());) {
    if (Date.now() > end) throw new Error(`timed out waiting until ${what}`)
    await new Promise((r) => setTimeout(r, 250))
  }
}

before(async () => {
  assert.ok(stack, "CAMPFLARE_E2E_STACK is not set: run the tests through e2e/run.ts")
  await launch()
})

after(quit)

test("with no session, the app opens on the sign-in screen", async () => {
  assert.equal(await text(await find("//h1")), "Sign in to Campflare")
  // The Server and Token fields, by their labels.
  const server = await find("//label[span[normalize-space()='Server']]//input")
  const token = await find("//label[span[normalize-space()='Token']]//input")
  assert.equal(await attribute(token, "type"), "password")
  assert.ok(server)
  // Both ways in: the browser (OAuth through the loopback listener) and a pasted token.
  assert.ok(await find("//button[normalize-space()='Sign in with your browser']"))
  assert.ok(await find("//button[normalize-space()='Sign in with a token']"))
})

test("signs in with a pasted token, lists the channels and sends a message", async () => {
  const { apiUrl, token, general } = stack!
  await fill(await find("//label[span[normalize-space()='Server']]//input"), apiUrl)
  await fill(await find("//label[span[normalize-space()='Token']]//input"), token)
  await click(await find("//button[normalize-space()='Sign in with a token']"))

  // Signed in and live: the workspace's channels, #general open, the realtime link up.
  await find(CONNECTED)
  for (const name of ["general", "dev", "random"])
    await find(`//nav[@aria-label='Channels']//button[span[normalize-space()='${name}']]`)
  await find("//h1[normalize-space()='general']")

  if (expectFile) {
    // The fallback, said once and not in the way: a toast.
    await find("//li[@data-sonner-toast][contains(., 'no keyring')]")
    assert.ok(sessionFile, "CAMPFLARE_DESKTOP_CONFIG is not set: the session file is checked on Linux only")
    await until("the session file is written", () => existsSync(sessionFile))
    assert.equal(statSync(sessionFile).mode & 0o777, 0o600)
    const kept = JSON.parse(readFileSync(sessionFile, "utf8")) as { url: string; token: string }
    assert.deepEqual([kept.url, kept.token], [apiUrl, token])
  }

  await fill(await find("//textarea[@aria-label='Message #general']"), message)
  await click(await find("//button[@aria-label='Send' and not(@disabled)]"))
  // The delivered copy, not the pending one ("<name> at sending"): the stored
  // message replaces that node, which would leave a stale element to read.
  const shown = await text(await find(`${ourMessage}[not(contains(@aria-label, ' at sending'))]`))
  assert.ok(shown.includes(message), shown)

  // It reached the server, not just the screen.
  await until("the server has the message", async () => {
    const res = await fetch(`${apiUrl}/api/conversations.history?channel=${general}&limit=20`, {
      headers: { authorization: `Bearer ${token}` },
    })
    const body = (await res.json()) as { messages?: { text: string }[] }
    return body.messages?.some((m) => m.text === message) ?? false
  })
})

test("after a restart, the app opens signed in", async () => {
  await quit()
  await launch()
  await find(CONNECTED)
  await find(ourMessage)
})

test("signing out forgets the session, across a restart", async () => {
  // The workspace menu is the button around the connection status.
  await click(await find("//button[.//*[@role='status']]"))
  await click(await find("//*[@role='menuitem'][contains(normalize-space(), 'Sign out')]"))
  await find(SIGN_IN)
  if (expectFile) await until("the session file is gone", () => !existsSync(sessionFile!))

  await quit()
  await launch()
  assert.equal(await text(await find("//h1")), "Sign in to Campflare")
})
