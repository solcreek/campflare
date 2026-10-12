// The run file of `pnpm dev:all`: which server and app a local stack is
// serving, so tools find them without being told ports. It sits next to the
// env file (`<state>/../campflare-dev.run.json`), is written once everything
// answers, and is removed on a clean exit. One whose process is gone is stale
// and reads as nothing.

import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"

export interface DevStack {
  /** The Campflare server, e.g. http://localhost:51234 */
  apiUrl: string
  /** The app's Vite dev server, when started with --web. */
  appUrl?: string
  /** The env file the CLI, `pnpm otui` and the app read. */
  envFile: string
  /** The `pnpm dev:all` process serving them. */
  pid: number
}

const RUN_FILE = "campflare-dev.run.json"

/** The run file for a state directory: next to its env file, in the state's parent. */
export function stackFile(state: string): string {
  return join(dirname(resolve(state)), RUN_FILE)
}

/**
 * Which stack a tool means: `--state <dir>`, else the one whose env file
 * `CAMPFLARE_DEV_ENV` names, else the repo's default (`apps/server/.wrangler`).
 */
export function chooseStackFile(root: string, state?: string, devEnv?: string): string {
  if (state) return stackFile(state)
  if (devEnv) return join(dirname(resolve(root, devEnv)), RUN_FILE)
  return join(root, "apps/server/.wrangler", RUN_FILE)
}

/** Whether a process is alive. EPERM means it is, just not ours to signal. */
export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM"
  }
}

/** The stack's description if it parses and its process lives; otherwise null. */
export function parseStack(text: string, alive: (pid: number) => boolean = pidAlive): DevStack | null {
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch {
    return null
  }
  if (typeof data !== "object" || data === null) return null
  const { apiUrl, appUrl, envFile, pid } = data as Record<string, unknown>
  if (typeof apiUrl !== "string" || typeof envFile !== "string") return null
  if (appUrl !== undefined && typeof appUrl !== "string") return null
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0 || !alive(pid)) return null
  return { apiUrl, ...(appUrl ? { appUrl } : {}), envFile, pid }
}

export function readStack(file: string, alive: (pid: number) => boolean = pidAlive): DevStack | null {
  return existsSync(file) ? parseStack(readFileSync(file, "utf8"), alive) : null
}

export function writeStack(file: string, stack: DevStack): void {
  writeFileSync(file, `${JSON.stringify(stack, null, 2)}\n`)
}

/** Removes the run file if it is still this process's (another run may have taken the state over). */
export function removeStack(file: string, pid = process.pid): void {
  try {
    const data = JSON.parse(readFileSync(file, "utf8")) as { pid?: unknown }
    if (data.pid === pid) rmSync(file, { force: true })
  } catch {
    // gone or unreadable: nothing of ours to remove
  }
}
