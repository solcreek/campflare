import { spawn, execFileSync, type ChildProcess } from "node:child_process"
import { mkdtempSync, rmSync } from "node:fs"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import type { TestProject } from "vitest/node"

// Runs the real Worker under `wrangler dev` (workerd, local D1/R2/DO) on a
// free port with fresh state, so the official Slack SDKs talk to it over HTTP
// and WebSockets exactly as they would to slack.com.

const server = resolve(import.meta.dirname, "../../apps/server")
const wrangler = join(server, "node_modules/.bin/wrangler")

function freePort(): Promise<number> {
  return new Promise((ok) => {
    const s = createServer().listen(0, () => {
      const { port } = s.address() as { port: number }
      s.close(() => ok(port))
    })
  })
}

let child: ChildProcess | undefined
let state: string | undefined

export async function setup(project: TestProject) {
  state = mkdtempSync(join(tmpdir(), "campflare-conformance-"))
  execFileSync(wrangler, ["d1", "migrations", "apply", "campflare", "--local", "--persist-to", state], {
    cwd: server,
    stdio: "ignore",
  })
  const port = await freePort()
  child = spawn(
    wrangler,
    [
      "dev",
      "--port",
      String(port),
      "--persist-to",
      state,
      "--var",
      "BOOTSTRAP_SECRET:conformance",
      "--var",
      "SIGNING_KEY:conformance",
    ],
    { cwd: server, stdio: ["ignore", "pipe", "pipe"] },
  )
  let log = ""
  child.stdout?.on("data", (d) => (log += d))
  child.stderr?.on("data", (d) => (log += d))
  const base = `http://127.0.0.1:${port}`
  for (let i = 0; ; i++) {
    try {
      if ((await fetch(base)).ok) break
    } catch {
      // not up yet
    }
    if (i > 120) throw new Error(`wrangler dev did not start:\n${log}`)
    await new Promise((r) => setTimeout(r, 250))
  }
  project.provide("baseUrl", base)
}

export async function teardown() {
  child?.kill("SIGTERM")
  if (state) rmSync(state, { recursive: true, force: true })
}

declare module "vitest" {
  export interface ProvidedContext {
    baseUrl: string
  }
}
