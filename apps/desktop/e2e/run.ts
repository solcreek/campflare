// pnpm --filter @campflare/desktop e2e: the desktop app itself, driven over
// WebDriver. tauri-driver (cargo install tauri-driver --locked) sits in front
// of the platform's own driver: WebKitWebDriver on Linux (webkit2gtk-driver),
// msedgedriver on Windows. macOS has no WebDriver for WKWebView, so these
// tests can't run there: use the browser tests (pnpm e2e) on a Mac.
//
//   node e2e/run.ts              build the debug app, then test it
//   node e2e/run.ts --no-build   test the binary already built
//
// It starts a fresh, seeded server for the app to sign in to (scripts/dev.ts
// --port 0, its state in a temporary directory) and stops it afterwards.
// On Linux without a display, run it under xvfb-run. See
// https://v2.tauri.app/develop/tests/webdriver/

import { type ChildProcess, execFileSync, spawn } from "node:child_process"
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { connect } from "node:net"
import { homedir, tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { parseArgs } from "node:util"
import type { Seeded } from "../../../scripts/seed.ts"

const desktop = resolve(import.meta.dirname, "..")
const root = resolve(desktop, "../..")
const { values } = parseArgs({ options: { build: { type: "boolean", default: true } }, allowNegative: true })

if (process.platform === "darwin") {
  console.error(
    "The desktop end-to-end tests run on Linux and Windows only: Tauri's WebDriver support (tauri-driver)\n" +
      "has no driver for macOS's WKWebView. CI runs them on Linux (.github/workflows/desktop.yml).\n" +
      "On a Mac, `pnpm e2e` tests the same app in Chromium.",
  )
  process.exit(1)
}

const exe = process.platform === "win32" ? ".exe" : ""
const app = process.env.CAMPFLARE_DESKTOP_APP ?? join(desktop, `src-tauri/target/debug/campflare-desktop${exe}`)

if (values.build) {
  // `tauri build --debug`, not `cargo build`: only the CLI embeds the built
  // web app (frontendDist); a plain debug build would load the Vite dev URL.
  execFileSync("pnpm", ["tauri", "build", "--debug", "--no-bundle"], {
    cwd: desktop,
    stdio: "inherit",
    shell: process.platform === "win32",
  })
}
if (!existsSync(app)) {
  console.error(`No app at ${app}: build it with \`pnpm tauri build --debug --no-bundle\` in apps/desktop.`)
  process.exit(1)
}

const work = mkdtempSync(join(tmpdir(), "campflare-desktop-e2e-"))
const children: ChildProcess[] = []

/** Stops the server and the driver, removes the run's directory, and exits. */
async function finish(code: number): Promise<never> {
  await Promise.all(
    children.map(async (child) => {
      if (child.exitCode !== null || child.signalCode !== null) return
      const exited = new Promise((r) => child.once("exit", r))
      child.kill("SIGTERM")
      await exited
    }),
  )
  rmSync(work, { recursive: true, force: true })
  process.exit(code)
}

// A server for the app to sign in to: `pnpm dev:all --port 0` with fresh
// state and the seed (no web dev server: the app embeds the built web app).
const state = join(work, "state")
let serverLog = ""
const server = spawn(process.execPath, [join(root, "scripts/dev.ts"), "--port", "0", "--state", state], {
  cwd: root,
  stdio: ["ignore", "pipe", "pipe"],
})
children.push(server)
server.stdout?.on("data", (d) => (serverLog += d))
server.stderr?.on("data", (d) => (serverLog += d))
// dev.ts writes the env file next to the state once the workspace is seeded.
const envFile = join(work, "campflare-dev.env")
for (let i = 0; !existsSync(envFile); i++) {
  if (i > 480 || server.exitCode !== null) {
    console.error(`The server did not come up:\n${serverLog}`)
    await finish(1)
  }
  await new Promise((r) => setTimeout(r, 250))
}
const apiUrl = /^CAMPFLARE_URL=(.*)$/m.exec(readFileSync(envFile, "utf8"))?.[1]
const seeded = JSON.parse(readFileSync(join(state, "campflare-dev.json"), "utf8")) as Seeded
const stack = { apiUrl, token: seeded.owner, general: seeded.channels.general }

// On Linux, config, data and cache directories of the run's own, so the app
// starts signed out and leaves nothing behind; tauri-driver and WebKitWebDriver
// pass the environment on to it. Its config directory holds the session file.
const xdg: Record<string, string> = {}
if (process.platform === "linux") {
  for (const kind of ["CONFIG", "DATA", "CACHE"]) xdg[`XDG_${kind}_HOME`] = join(work, kind.toLowerCase())
}
const { identifier } = JSON.parse(readFileSync(join(desktop, "src-tauri/tauri.conf.json"), "utf8")) as {
  identifier: string
}
const config = xdg.XDG_CONFIG_HOME ? { CAMPFLARE_DESKTOP_CONFIG: join(xdg.XDG_CONFIG_HOME, identifier) } : {}

const cargoBin = join(homedir(), ".cargo/bin", `tauri-driver${exe}`)
const driverPath = existsSync(cargoBin) ? cargoBin : `tauri-driver${exe}`
const port = 4444
const driver = spawn(driverPath, ["--port", String(port)], {
  stdio: ["ignore", "inherit", "inherit"],
  env: { ...process.env, ...xdg },
})
children.push(driver)
driver.on("error", (err) => {
  console.error(`Couldn't start tauri-driver (${err.message}). Install it: cargo install tauri-driver --locked`)
  void finish(1)
})

function listening(): Promise<boolean> {
  return new Promise((ok) => {
    const socket = connect(port, "127.0.0.1")
    socket.once("connect", () => (socket.end(), ok(true)))
    socket.once("error", () => ok(false))
  })
}
for (let i = 0; !(await listening()); i++) {
  if (i > 100 || driver.exitCode !== null) {
    console.error("tauri-driver did not start listening")
    await finish(1)
  }
  await new Promise((r) => setTimeout(r, 100))
}

const tests = spawn(process.execPath, ["--test", "--test-concurrency=1", join(desktop, "e2e/login.test.ts")], {
  stdio: "inherit",
  env: {
    ...process.env,
    ...config,
    CAMPFLARE_DESKTOP_APP: app,
    CAMPFLARE_E2E_STACK: JSON.stringify(stack),
    WEBDRIVER_URL: `http://127.0.0.1:${port}`,
  },
})
const code: number = await new Promise((ok) => tests.on("exit", (c) => ok(c ?? 1)))
if (code !== 0) console.error(`The server's output:\n${serverLog.slice(-20_000)}`)
await finish(code)
