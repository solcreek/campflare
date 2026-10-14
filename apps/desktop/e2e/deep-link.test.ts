// campflare:// links opening the desktop app, through tauri-driver (run by
// e2e/run.ts after login.test.ts). Linux opens a link by starting the app with
// it as the only argument: the first launch reads it through the deep-link
// plugin (getCurrent); a second launch, while the app runs, hands it to the
// running app (tauri-plugin-single-instance, over D-Bus) and exits. The tests
// run in order: signed in, started with a link here, with a link to another
// server, then sent one by a second launch.

import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { after, before } from "node:test"
import { click, fill, find, launch, quit, test, text } from "./driver.ts"
import { stack, until } from "./stack.ts"

const run = Date.now().toString(36)
const CONNECTED = "//*[@role='status' and @aria-label='Connected']"
const SIGN_IN = "//h1[normalize-space()='Sign in to Campflare']"
/** The highlighted message: the one a link points at. */
const linked = (scope: string) => `${scope}//article[@aria-current='true']`
const LOG = "//*[@role='log' and @aria-label='Messages']"
const THREAD = "//aside[@aria-label='Thread']"

/** A message posted as the seeded person, straight to the server. */
async function post(message: string, threadTs?: string): Promise<string> {
  const { apiUrl, token, general } = stack!
  const res = await fetch(`${apiUrl}/api/chat.postMessage`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ channel: general, text: message, ...(threadTs ? { thread_ts: threadTs } : {}) }),
  })
  const body = (await res.json()) as { ok: boolean; ts?: string; error?: string }
  assert.ok(body.ok && body.ts, `chat.postMessage: ${body.error}`)
  return body.ts
}

/** The link for the desktop app to a message on the test server, as the server's desktopLink makes it. */
function link(ts: string, threadTs?: string): string {
  const { apiUrl, general } = stack!
  const thread = threadTs ? `?thread_ts=${threadTs}&cid=${general}` : ""
  return `campflare://${new URL(apiUrl).host}/archives/${general}/p${ts.replace(".", "")}${thread}`
}

let head = ""
let reply = ""

before(async () => {
  assert.ok(stack, "CAMPFLARE_E2E_STACK is not set: run the tests through e2e/run.ts")
  head = await post(`Deep link 深い链接 · 딥 링크 · enlace · lien · Verknüpfung ${run}`)
  reply = await post(`Reply 答复 · 返信 · 답장 · respuesta · réponse · Antwort ${run}`, head)
  // Signed in, as a person would be before following a link (login.test.ts ends signed out).
  await launch()
  await find(SIGN_IN)
  await fill(await find("//label[span[normalize-space()='Server']]//input"), stack.apiUrl)
  await fill(await find("//label[span[normalize-space()='Token']]//input"), stack.token)
  await click(await find("//button[normalize-space()='Sign in with a token']"))
  await find(CONNECTED)
  await quit()
})

after(quit)

test("started with a link, the app opens the message on its server", async () => {
  await launch([link(head)])
  await find(CONNECTED)
  const shown = await text(await find(linked(LOG)))
  assert.ok(shown.includes(`Deep link 深い链接`) && shown.includes(run), shown)
})

test("a link to another server says so, rather than not finding the message", async () => {
  await quit()
  await launch(["campflare://chat.elsewhere.test/archives/C0123ABC/p1700000000000100"])
  await find(CONNECTED)
  const dialog = await find("//*[@role='dialog'][.//*[normalize-space()='This link is to another server']]")
  const said = await text(dialog)
  assert.ok(said.includes("chat.elsewhere.test") && said.includes(new URL(stack!.apiUrl).host), said)
  await click(await find("//*[@role='dialog']//button[normalize-space()='Close']"))
})

// Without a session bus there is no single instance: the second launch would be a second app.
const bus = Boolean(process.env.DBUS_SESSION_BUS_ADDRESS)

test(
  "a second launch with a link hands it to the running app, and exits",
  async () => {
    const app = process.env.CAMPFLARE_DESKTOP_APP!
    const second = spawn(app, [link(reply, head)], { stdio: "ignore" })
    const exited = new Promise<number | null>((ok) => second.once("exit", (code) => ok(code)))
    const timeout = setTimeout(() => second.kill("SIGKILL"), 20_000)
    try {
      assert.equal(await exited, 0, "the second launch should hand the link over and exit")
    } finally {
      clearTimeout(timeout)
    }
    // The running app opens the reply's thread with the reply highlighted.
    const shown = await text(await find(linked(THREAD)))
    assert.ok(shown.includes("Reply 答复") && shown.includes(run), shown)
    await until("the head is highlighted in the conversation", async () =>
      (await text(await find(linked(LOG)))).includes("Deep link"),
    )
  },
  { skip: bus ? false : "no D-Bus session bus (run under dbus-run-session)" },
)
