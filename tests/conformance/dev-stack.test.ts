import { spawn } from "node:child_process"
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import {
  chooseStackFile,
  parseStack,
  pidAlive,
  readStack,
  removeStack,
  stackFile,
  writeStack,
} from "../../scripts/dev-stack.ts"

// The run file that `pnpm dev:all` leaves for `pnpm shot` and friends.

const root = resolve(import.meta.dirname, "../..")
let dir: string | undefined
const scratch = () => (dir = mkdtempSync(join(tmpdir(), "campflare-stack-")))
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true })
  dir = undefined
})

const stack = { apiUrl: "http://localhost:4100", appUrl: "http://localhost:4200", envFile: "/x/campflare-dev.env" }
const alive = () => true

describe("the dev stack's run file", () => {
  it("sits next to the env file, in the state directory's parent", () => {
    expect(stackFile("/a/b/state")).toBe("/a/b/campflare-dev.run.json")
    // --state wins, then the env file a tool was pointed at, then the repo's default.
    expect(chooseStackFile(root, "/a/b/state", "/c/campflare-dev.env")).toBe("/a/b/campflare-dev.run.json")
    expect(chooseStackFile(root, undefined, "/c/campflare-dev.env")).toBe("/c/campflare-dev.run.json")
    expect(chooseStackFile(root, undefined, "apps/server/.wrangler/campflare-dev.env")).toBe(
      join(root, "apps/server/.wrangler/campflare-dev.run.json"),
    )
    expect(chooseStackFile(root)).toBe(join(root, "apps/server/.wrangler/campflare-dev.run.json"))
  })

  it("reads only well-formed stacks whose process lives", () => {
    expect(parseStack(JSON.stringify({ ...stack, pid: 42 }), alive)).toEqual({ ...stack, pid: 42 })
    const { appUrl: _, ...noApp } = stack
    expect(parseStack(JSON.stringify({ ...noApp, pid: 42 }), alive)).toEqual({ ...noApp, pid: 42 })
    expect(parseStack(JSON.stringify({ ...stack, pid: 42 }), () => false)).toBeNull()
    for (const bad of ["", "{", "null", "[]", JSON.stringify({ ...stack }), JSON.stringify({ ...stack, pid: "42" })])
      expect(parseStack(bad, alive)).toBeNull()
    expect(parseStack(JSON.stringify({ ...stack, apiUrl: 1, pid: 42 }), alive)).toBeNull()
    expect(parseStack(JSON.stringify({ ...stack, appUrl: 1, pid: 42 }), alive)).toBeNull()
    expect(parseStack(JSON.stringify({ ...stack, pid: -1 }), alive)).toBeNull()
  })

  it("knows a live process from a dead one", async () => {
    expect(pidAlive(process.pid)).toBe(true)
    const gone = spawn(process.execPath, ["-e", ""])
    await new Promise((r) => gone.on("exit", r))
    expect(pidAlive(gone.pid!)).toBe(false)
  })

  it("is written, read back, and removed only by the process that wrote it", () => {
    const file = join(scratch(), "campflare-dev.run.json")
    expect(readStack(file)).toBeNull()
    writeStack(file, { ...stack, pid: process.pid })
    expect(readStack(file)).toEqual({ ...stack, pid: process.pid })
    removeStack(file, process.pid + 1)
    expect(existsSync(file)).toBe(true)
    removeStack(file)
    expect(existsSync(file)).toBe(false)
    removeStack(file) // already gone: fine
    writeFileSync(file, "not json")
    removeStack(file)
    expect(existsSync(file)).toBe(true)
  })

  it(
    "pnpm dev:all --port 0 --web serves the server and the app, says where, and cleans up",
    { timeout: 90_000 },
    async () => {
      const tmp = scratch()
      const state = join(tmp, "state")
      const file = stackFile(state)
      const dev = spawn(process.execPath, [join(root, "scripts/dev.ts"), "--port", "0", "--web", "--state", state], {
        cwd: root,
        stdio: ["ignore", "ignore", "pipe"],
      })
      let stderr = ""
      dev.stderr.on("data", (d: Buffer) => (stderr += d))
      const exited = new Promise<number | null>((r) => dev.on("exit", r))
      try {
        let found = readStack(file)
        for (let i = 0; !found && i < 300 && dev.exitCode === null; i++) {
          await new Promise((r) => setTimeout(r, 200))
          found = readStack(file)
        }
        if (!found) throw new Error(`dev.ts wrote no run file:\n${stderr}`)
        expect(found).toMatchObject({ pid: dev.pid, envFile: join(tmp, "campflare-dev.env") })
        expect(((await (await fetch(found!.apiUrl)).json()) as { name: string }).name).toBe("campflare")
        const page = await (await fetch(found!.appUrl!)).text()
        expect(page).toContain('<div id="root">')
        // The app signs in to this server, not whichever one the repo's default env file names.
        expect(readFileSync(found!.envFile, "utf8")).toContain(`CAMPFLARE_URL=${found!.apiUrl}`)
        dev.kill("SIGTERM")
        await exited
        expect(existsSync(file)).toBe(false)
        await expect(fetch(found!.appUrl!)).rejects.toThrow("fetch failed")
      } finally {
        dev.kill("SIGKILL")
      }
    },
  )
})
