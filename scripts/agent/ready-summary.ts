// What `pnpm ready --quick` finds wrong, in a few lines for the agent's
// context at session start. Nothing when all is well.

import { execFileSync } from "node:child_process"
import { resolve } from "node:path"

const root = resolve(import.meta.dirname, "../..")
let report: { ok: boolean; checks: { name: string; ok: boolean; advisory?: boolean; detail: string; fix?: string }[] }
try {
  report = JSON.parse(
    execFileSync(process.execPath, ["scripts/ready.ts", "--quick", "--json"], {
      cwd: root,
      stdio: ["ignore", "pipe", "ignore"],
    }).toString(),
  )
} catch (error) {
  // ready exits 1 when something is wrong; its report is still on stdout.
  const stdout = (error as { stdout?: Buffer }).stdout?.toString()
  if (!stdout) process.exit(0)
  report = JSON.parse(stdout)
}
const wrong = report.checks.filter((c) => !c.ok && !c.advisory)
if (wrong.length) {
  console.log("This checkout isn't ready (pnpm ready):")
  for (const c of wrong) console.log(`- ${c.name}: ${c.detail}${c.fix ? ` (fix: ${c.fix})` : ""}`)
  console.log("`pnpm ready --fix` repairs what it can.")
}
