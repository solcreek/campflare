import { spawn, type ChildProcess } from "node:child_process"
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { createServer as listen } from "node:net"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import type { FullConfig } from "@playwright/test"
import { createServer, type ViteDevServer } from "vite"

// The whole stack, fresh for each run: `pnpm dev:all` on a free port with its
// own state and seed, then the app's Vite dev server signed in to it, so the
// browser tests drive what a person would.

const root = resolve(import.meta.dirname, "../../..")

function freePort(): Promise<number> {
  return new Promise((ok) => {
    const s = listen().listen(0, () => {
      const { port } = s.address() as { port: number }
      s.close(() => ok(port))
    })
  })
}

export interface Stack {
  appUrl: string
  apiUrl: string
  /** The seeded people's user tokens, by handle. */
  people: Record<string, string>
}

export default async function setup(_config: FullConfig) {
  const dir = mkdtempSync(join(tmpdir(), "campflare-e2e-"))
  const envFile = join(dir, "campflare-dev.env")
  const apiPort = await freePort()
  // Chosen before the server starts: its permalinks redirect to the app (APP_URL).
  const webPort = await freePort()
  let log = ""
  const args = ["--port", String(apiPort), "--state", join(dir, "state"), "--app-url", `http://localhost:${webPort}/`]
  const api: ChildProcess = spawn(process.execPath, [join(root, "scripts/dev.ts"), ...args], {
    cwd: root,
    stdio: ["ignore", "pipe", "pipe"],
  })
  api.stdout?.on("data", (d) => (log += d))
  api.stderr?.on("data", (d) => (log += d))
  // dev.ts writes the env file once the workspace is seeded.
  for (let i = 0; !existsSync(envFile); i++) {
    if (i > 240 || api.exitCode !== null) throw new Error(`pnpm dev:all did not come up:\n${log}`)
    await new Promise((r) => setTimeout(r, 250))
  }

  process.env.CAMPFLARE_DEV_ENV = envFile
  const web: ViteDevServer = await createServer({
    root: resolve(import.meta.dirname, ".."),
    configFile: resolve(import.meta.dirname, "../vite.config.ts"),
    server: { port: webPort, strictPort: true },
    logLevel: "warn",
  })
  await web.listen()

  const env = Object.fromEntries(
    readFileSync(envFile, "utf8")
      .split("\n")
      .flatMap((line) => (/^[A-Z_]+=/.test(line) ? [line.split(/=(.*)/s).slice(0, 2)] : [])),
  ) as Record<string, string>
  const people: Record<string, string> = { alex: env.CAMPFLARE_TOKEN! }
  for (const [k, v] of Object.entries(env)) if (k.startsWith("CAMPFLARE_TOKEN_")) people[k.slice(16).toLowerCase()] = v
  const stack: Stack = { appUrl: `http://localhost:${webPort}`, apiUrl: `http://localhost:${apiPort}`, people }
  process.env.CAMPFLARE_E2E = JSON.stringify(stack)

  return async () => {
    await web.close()
    api.kill("SIGTERM")
    await new Promise((r) => api.once("exit", r))
    rmSync(dir, { recursive: true, force: true })
  }
}
