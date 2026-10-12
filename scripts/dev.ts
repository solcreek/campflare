// pnpm dev:all — the whole local stack in one command:
// migrations, `wrangler dev`, a seeded workspace on first run, and the env
// file that the CLI and `pnpm otui` read.
//
//   pnpm dev:all                  port 8787, state in apps/server/.wrangler/state
//   pnpm dev:all --port 0         any free port (parallel worktrees)
//   pnpm dev:all --fresh          wipe the state first
//   pnpm dev:all --no-seed        an empty server

import { execFileSync, spawn } from "node:child_process"
import { copyFileSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { createServer } from "node:net"
import { dirname, join, resolve } from "node:path"
import { parseArgs } from "node:util"
import { seed, type Seeded } from "./seed.ts"

const root = resolve(import.meta.dirname, "..")
const server = join(root, "apps/server")
const wrangler = join(server, "node_modules/.bin/wrangler")

const { values } = parseArgs({
  options: {
    port: { type: "string", default: "8787" },
    state: { type: "string" },
    fresh: { type: "boolean", default: false },
    seed: { type: "boolean", default: true },
  },
  allowNegative: true,
})

const state = resolve(values.state ?? join(server, ".wrangler/state"))
const seededFile = join(state, "campflare-dev.json")
/** Written each run (the port can change), read by the CLI and scripts/otui.sh. */
const envFile = join(dirname(state), "campflare-dev.env")

function freePort(): Promise<number> {
  return new Promise((ok) => {
    const s = createServer().listen(0, () => {
      const { port } = s.address() as { port: number }
      s.close(() => ok(port))
    })
  })
}

function devVars(): Record<string, string> {
  const path = join(server, ".dev.vars")
  if (!existsSync(path)) copyFileSync(join(server, ".dev.vars.example"), path)
  return Object.fromEntries(
    readFileSync(path, "utf8")
      .split("\n")
      .flatMap((line) => {
        const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/)
        return m ? [[m[1]!, m[2]!.replace(/^(['"])(.*)\1$/, "$2")]] : []
      }),
  )
}

if (values.fresh) rmSync(state, { recursive: true, force: true })
const vars = devVars()
execFileSync(wrangler, ["d1", "migrations", "apply", "campflare", "--local", "--persist-to", state], {
  cwd: server,
  stdio: ["ignore", "ignore", "inherit"],
})

const port = values.port === "0" ? await freePort() : Number(values.port)
const url = `http://localhost:${port}`
const child = spawn(wrangler, ["dev", "--port", String(port), "--persist-to", state], {
  cwd: server,
  stdio: ["inherit", "inherit", "inherit"],
})
for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => child.kill(signal))
child.on("exit", (code) => process.exit(code ?? 0))

for (let i = 0; ; i++) {
  try {
    if ((await fetch(url)).ok) break
  } catch {
    // not up yet
  }
  if (i > 240) throw new Error(`wrangler dev did not answer on ${url}`)
  await new Promise((r) => setTimeout(r, 250))
}

let seeded: Seeded | undefined = existsSync(seededFile)
  ? (JSON.parse(readFileSync(seededFile, "utf8")) as Seeded)
  : undefined
if (!seeded && values.seed) {
  if (!vars.BOOTSTRAP_SECRET) throw new Error("BOOTSTRAP_SECRET is missing from apps/server/.dev.vars")
  seeded = await seed(url, vars.BOOTSTRAP_SECRET)
  writeFileSync(seededFile, `${JSON.stringify(seeded, null, 2)}\n`, { mode: 0o600 })
}

const lines = [`CAMPFLARE_URL=${url}`, `SLACK_API_URL=${url}`]
if (seeded) {
  lines.push(
    `CAMPFLARE_TOKEN=${seeded.owner}`,
    `CAMPFLARE_APP_TOKEN=${seeded.appToken}`,
    `SLACK_USER_TOKEN=${seeded.owner}`,
    `SLACK_APP_TOKEN=${seeded.appToken}`,
    ...Object.entries(seeded.people).map(([name, token]) => `CAMPFLARE_TOKEN_${name.toUpperCase()}=${token}`),
  )
}
writeFileSync(envFile, `# Written by pnpm dev:all; the tokens belong to ${state}\n${lines.join("\n")}\n`, {
  mode: 0o600,
})

const rel = (p: string) => p.replace(`${root}/`, "")
const custom = values.state ? `CAMPFLARE_DEV_ENV=${rel(envFile)} ` : ""
console.log(`
  Campflare is up on ${url}
  state  ${rel(state)}${seeded ? "\n  team   Campflare Dev: you are @alex; also vincent, minjun, ada" : ""}
  env    ${rel(envFile)}

  In another terminal:
    ${custom}pnpm otui                     # opentui-slack against this server
    set -a; . ${rel(envFile)}; set +a    # then the CLI acts as @alex:
    campflare send '#dev' "hello"
    CAMPFLARE_TOKEN=$CAMPFLARE_TOKEN_VINCENT campflare send @alex "hi"
`)
