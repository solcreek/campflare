// Claude Code PostToolUse hook for Edit/Write: formats the file just written
// (oxfmt, so formatting is never the agent's concern) and lints it (oxlint).
// Lint errors exit 2, which hands them back to the agent to fix now.

import { spawnSync } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { relative, resolve } from "node:path"

const root = resolve(import.meta.dirname, "../..")
const FORMATTED = /\.(ts|tsx|mts|js|mjs|json|jsonc|md|css)$/
const LINTED = /\.(ts|tsx|mts|js|mjs)$/

const input = JSON.parse(readFileSync(0, "utf8") || "{}") as { tool_input?: { file_path?: string } }
const file = input.tool_input?.file_path
if (!file || !existsSync(file)) process.exit(0)
const rel = relative(root, resolve(file))
// Outside the repo, generated, or vendored: not ours to touch.
if (rel.startsWith("..") || /(^|\/)(node_modules|dist|\.wrangler|coverage)\//.test(rel) || !FORMATTED.test(rel))
  process.exit(0)

const bin = (name: string) => resolve(root, "node_modules/.bin", name)
spawnSync(bin("oxfmt"), [rel], { cwd: root, stdio: "ignore" })
if (LINTED.test(rel)) {
  const lint = spawnSync(bin("oxlint"), ["--deny-warnings", rel], { cwd: root, encoding: "utf8" })
  if (lint.status !== 0) {
    process.stderr.write(`oxlint found problems in ${rel}:\n${lint.stdout}${lint.stderr}`)
    process.exit(2)
  }
}
