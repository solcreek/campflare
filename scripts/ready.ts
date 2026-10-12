// pnpm ready — is this checkout ready to develop and test? One line per
// check; --fix runs the fixes it knows; --json for agents; --quick skips the
// slow ones (the migration list starts wrangler). Exits 1 if a required check
// still fails.

import { execFileSync, execSync } from "node:child_process"
import { homedir } from "node:os"
import { resolve } from "node:path"
import { parseArgs } from "node:util"
import {
  bundles,
  dependencies,
  devPort,
  devVars,
  migrations,
  nodeVersion,
  opentuiSlack,
  pnpmVersion,
  toolchainSource,
  type Check,
} from "./ready-checks.ts"

const root = resolve(import.meta.dirname, "..")
const { values } = parseArgs({
  options: {
    fix: { type: "boolean", default: false },
    json: { type: "boolean", default: false },
    quick: { type: "boolean", default: false },
  },
})

function pnpmOnPath(): string | undefined {
  try {
    return execFileSync("pnpm", ["--version"], { cwd: root, stdio: ["ignore", "pipe", "ignore"] })
      .toString()
      .trim()
  } catch {
    return undefined
  }
}

async function run(): Promise<Check[]> {
  return [
    nodeVersion(root),
    pnpmVersion(root, pnpmOnPath()),
    dependencies(root),
    devVars(root),
    bundles(root),
    ...(values.quick ? [] : [migrations(root)]),
    await devPort(),
    opentuiSlack(homedir(), process.env),
    toolchainSource(),
  ]
}

let checks = await run()
const failing = () => checks.filter((c) => !c.ok && !c.advisory)

if (values.fix) {
  // Fixes run in this order: install first, since the others need node_modules.
  const fixes = [...new Set(failing().flatMap((c) => (c.fix && !c.fix.includes("#") ? [c.fix] : [])))]
  for (const command of fixes) {
    if (!values.json) console.log(`→ ${command}`)
    execSync(command, { cwd: root, stdio: values.json ? "ignore" : "inherit" })
  }
  if (fixes.length) checks = await run()
}

if (values.json) {
  console.log(JSON.stringify({ ok: failing().length === 0, checks }, null, 2))
} else {
  for (const c of checks) {
    const mark = c.ok ? "✓" : c.advisory ? "·" : "✗"
    console.log(`${mark} ${c.name.padEnd(13)} ${c.detail}${!c.ok && c.fix ? `\n  ${" ".repeat(14)}fix: ${c.fix}` : ""}`)
  }
  if (failing().length && !values.fix) console.log("\npnpm ready --fix runs the fixes it can.")
}
process.exitCode = failing().length ? 1 : 0
