// pnpm --filter @campflare/desktop e2e: the desktop app itself, driven over
// WebDriver. tauri-driver (cargo install tauri-driver --locked) sits in front
// of the platform's own driver: WebKitWebDriver on Linux (webkit2gtk-driver),
// msedgedriver on Windows. macOS has no WebDriver for WKWebView, so these
// tests can't run there: use the browser tests (pnpm e2e) on a Mac.
//
//   node e2e/run.ts              build the debug app, then test it
//   node e2e/run.ts --no-build   test the binary already built
//
// On Linux without a display, run it under xvfb-run. See
// https://v2.tauri.app/develop/tests/webdriver/

import { execFileSync, spawn } from "node:child_process"
import { existsSync } from "node:fs"
import { connect } from "node:net"
import { homedir } from "node:os"
import { join, resolve } from "node:path"
import { parseArgs } from "node:util"

const desktop = resolve(import.meta.dirname, "..")
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

const cargoBin = join(homedir(), ".cargo/bin", `tauri-driver${exe}`)
const driverPath = existsSync(cargoBin) ? cargoBin : `tauri-driver${exe}`
const port = 4444
const driver = spawn(driverPath, ["--port", String(port)], { stdio: ["ignore", "inherit", "inherit"] })
driver.on("error", (err) => {
  console.error(`Couldn't start tauri-driver (${err.message}). Install it: cargo install tauri-driver --locked`)
  process.exit(1)
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
    driver.kill()
    process.exit(1)
  }
  await new Promise((r) => setTimeout(r, 100))
}

const tests = spawn(process.execPath, ["--test", "--test-concurrency=1", join(desktop, "e2e/login.test.ts")], {
  stdio: "inherit",
  env: { ...process.env, CAMPFLARE_DESKTOP_APP: app, WEBDRIVER_URL: `http://127.0.0.1:${port}` },
})
const code: number = await new Promise((ok) => tests.on("exit", (c) => ok(c ?? 1)))
driver.kill()
process.exit(code)
