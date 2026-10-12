// Claude Code Stop hook: when code changed this turn, the static checks
// (format, lint, typecheck; about 2 s) must pass before the agent stops.
// Failures exit 2 and go back to the agent. Tests are left to the agent: they
// take a minute, and it knows which ones matter.

import { execFileSync, spawnSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"

const root = resolve(import.meta.dirname, "../..")
const input = JSON.parse(readFileSync(0, "utf8") || "{}") as { stop_hook_active?: boolean }
// Already blocked once and still failing: let the agent stop and report, rather than loop.
if (input.stop_hook_active) process.exit(0)

const changed = execFileSync("git", ["status", "--porcelain", "--untracked-files=all"], { cwd: root })
  .toString()
  .split("\n")
  .map((line) => line.slice(3))
  .filter((path) => /\.(ts|tsx|mts|json|jsonc)$/.test(path))
if (changed.length === 0) process.exit(0)

const steps: [string, string[]][] = [
  ["format", ["fmt:check"]],
  ["lint", ["lint"]],
  ["typecheck", ["typecheck"]],
]
for (const [name, args] of steps) {
  const run = spawnSync("pnpm", ["-s", ...args], { cwd: root, encoding: "utf8" })
  if (run.status !== 0) {
    const output = `${run.stdout}${run.stderr}`.trim().split("\n").slice(-40).join("\n")
    process.stderr.write(`The ${name} check fails (pnpm ${args.join(" ")}); fix it before finishing:\n${output}\n`)
    process.exit(2)
  }
}
