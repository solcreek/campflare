import { spawn, execFileSync } from "node:child_process"
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

export interface Server {
  base: string
  stop(): Promise<void>
}

/**
 * Starts the Worker under `wrangler dev` with fresh state; BOOTSTRAP_SECRET and SIGNING_KEY are
 * "conformance". `config` is another wrangler config (apps/server/wrangler.jsonc by default),
 * `env` more environment for wrangler (credentials for remote bindings, say).
 */
export async function startServer({
  config,
  env,
  timeoutMs = 30_000,
}: { config?: string; env?: Record<string, string>; timeoutMs?: number } = {}): Promise<Server> {
  const state = mkdtempSync(join(tmpdir(), "campflare-conformance-"))
  const configArgs = config ? ["--config", config] : []
  const childEnv = { ...process.env, ...env }
  execFileSync(wrangler, ["d1", "migrations", "apply", "campflare", "--local", "--persist-to", state, ...configArgs], {
    cwd: server,
    stdio: "ignore",
    env: childEnv,
  })
  const port = await freePort()
  const child = spawn(
    wrangler,
    [
      "dev",
      ...configArgs,
      "--port",
      String(port),
      // Its own inspector port: suites started at once would otherwise race for 9229.
      "--inspector-port",
      String(await freePort()),
      "--persist-to",
      state,
      "--var",
      "BOOTSTRAP_SECRET:conformance",
      "--var",
      "SIGNING_KEY:conformance",
      // Push on, with a key pair made for the tests (the same as the server's unit tests').
      "--var",
      "VAPID_PUBLIC_KEY:BJQiCS-kDdMSnJJm-oewJ2ESIFX-sq5HFIE2TXDesZbHULYpnrUjid9rwNDjDehUKIZ8G_x_JsIRQA8jDTw20aA",
      "--var",
      "VAPID_PRIVATE_KEY:7dyzr08oHg1CxK68ptek_5k4dxYlkMOk5w3GDpCH8n8",
    ],
    { cwd: server, stdio: ["ignore", "pipe", "pipe"], env: childEnv },
  )
  let log = ""
  child.stdout?.on("data", (d) => (log += d))
  child.stderr?.on("data", (d) => (log += d))
  const stop = async () => {
    child.kill("SIGTERM")
    rmSync(state, { recursive: true, force: true })
  }
  const base = `http://127.0.0.1:${port}`
  const end = Date.now() + timeoutMs
  for (;;) {
    try {
      if ((await fetch(base)).ok) break
    } catch {
      // not up yet
    }
    if (Date.now() > end || child.exitCode !== null) {
      await stop()
      throw new Error(`wrangler dev did not start:\n${log}`)
    }
    await new Promise((r) => setTimeout(r, 250))
  }
  return { base, stop }
}

let started: Server | undefined

export async function setup(project: TestProject) {
  started = await startServer()
  project.provide("baseUrl", started.base)
}

export async function teardown() {
  await started?.stop()
}

declare module "vitest" {
  export interface ProvidedContext {
    baseUrl: string
  }
}
