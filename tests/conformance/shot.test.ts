import { execFile, spawn, type ChildProcess } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { readStack, stackFile, type DevStack } from "../../scripts/dev-stack.ts"
import { browsers } from "../../scripts/ready-checks.ts"

// `pnpm shot` end to end: a `pnpm dev:all --port 0 --web` stack of its own,
// then shot.ts finds it by --state, acts on a conversation in Chromium, and
// reports. apps/web/test/shot.test.ts covers its options without a browser.

const root = resolve(import.meta.dirname, "../..")
const chromium = browsers(root)
// CI installs Chromium before `pnpm check`; a laptop without it skips, saying why.
const skip = !chromium.ok && !process.env.CI
if (skip) process.stderr.write(`Skipping pnpm shot end to end: ${chromium.detail} (fix: ${chromium.fix})\n`)

// The app's dev server signs itself in only outside vitest (VITEST=true, which children inherit).
const outsideVitest = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("VITEST")))

let tmp: string
let dev: ChildProcess | undefined
let stack: DevStack
let random: string

beforeAll(async () => {
  if (skip) return
  tmp = mkdtempSync(join(tmpdir(), "campflare-shot-"))
  const state = join(tmp, "state")
  dev = spawn(process.execPath, [join(root, "scripts/dev.ts"), "--port", "0", "--web", "--state", state], {
    cwd: root,
    env: outsideVitest,
    stdio: ["ignore", "ignore", "pipe"],
  })
  let stderr = ""
  dev.stderr!.on("data", (d: Buffer) => (stderr += d))
  let found = readStack(stackFile(state))
  for (let i = 0; !found && i < 300 && dev.exitCode === null; i++) {
    await new Promise((r) => setTimeout(r, 200))
    found = readStack(stackFile(state))
  }
  if (!found) throw new Error(`dev.ts wrote no run file:\n${stderr}`)
  stack = found

  const token = /^CAMPFLARE_TOKEN=(.*)$/m.exec(readFileSync(stack.envFile, "utf8"))![1]!
  const res = await fetch(`${stack.apiUrl}/api/conversations.list`, { headers: { authorization: `Bearer ${token}` } })
  const { channels } = (await res.json()) as { channels: { id: string; name: string }[] }
  random = channels.find((c) => c.name === "random")!.id
}, 90_000)

afterAll(async () => {
  if (dev && dev.exitCode === null) {
    const exited = new Promise((r) => dev!.once("exit", r))
    dev.kill("SIGTERM")
    await exited
  }
  if (tmp) rmSync(tmp, { recursive: true, force: true })
})

/** Runs shot.ts against this file's stack; never rejects, so failures can be asserted on. */
function shot(...args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const env = { ...outsideVitest }
  // Only --state picks the stack: not a port or env file from the shell running the tests.
  delete env.CAMPFLARE_WEB_PORT
  delete env.CAMPFLARE_DEV_ENV
  delete env.INIT_CWD
  return new Promise((ok) =>
    execFile(
      process.execPath,
      [join(root, "apps/web/scripts/shot.ts"), "--state", join(tmp, "state"), ...args],
      { cwd: tmp, env, timeout: 60_000 },
      (error, stdout, stderr) => ok({ code: error ? Number(error.code ?? 1) : 0, stdout, stderr }),
    ),
  )
}

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

describe.skipIf(skip)("pnpm shot", () => {
  it("opens a conversation, acts in order, and saves what it saw", { timeout: 60_000 }, async () => {
    const text = "早安 こんにちは 안녕 ¿Qué tal? Ça va. Grüße"
    const out = join(tmp, "look.png")
    const { code, stdout, stderr } = await shot(
      `#/${random}`,
      "--click",
      "textbox:Message #random",
      "--type",
      text,
      "--press",
      "Enter",
      "--out",
      out,
      "--wait",
      "500",
    )
    // On failure, the report says what the page showed instead.
    expect({ code, stderr, ...(code ? { stdout } : {}) }).toEqual({ code: 0, stderr: "" })
    expect(stdout).toContain(`screenshot  ${out}  (${stack.appUrl}/#/${random})\nproblems    none\n`)

    const png = readFileSync(out)
    expect(png.subarray(0, 8)).toEqual(PNG)
    // IHDR, the first chunk, holds the size: the default 1280×800 window.
    expect(png.toString("latin1", 12, 16)).toBe("IHDR")
    expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([1280, 800])

    const outline = stdout.slice(stdout.indexOf("outline\n"))
    expect(outline).toContain('heading "random" [level=1]')
    expect(outline).toContain('log "Messages"')
    expect(outline).toContain('textbox "Message #random"')
    // Click, type, Enter, in that order: the text was sent, so it's in the log, not the composer.
    expect(outline).toContain(text)
  })

  it("fails, naming the step, when a click target isn't there", { timeout: 60_000 }, async () => {
    const out = join(tmp, "missing.png")
    const { code, stdout, stderr } = await shot("--click", "button:No such button", "--wait", "0", "--out", out)
    expect(code).toBe(1)
    expect(stderr).toMatch(/^shot: a step failed\n {2}--click button:No such button: .*Timeout 5000ms exceeded/)
    // The screenshot and report still come, with the step among the problems.
    expect(stdout).toContain("problems\n  --click button:No such button:")
    expect(readFileSync(out).subarray(0, 8)).toEqual(PNG)
  })
})
