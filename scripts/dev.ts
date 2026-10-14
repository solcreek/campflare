// pnpm dev:all — the whole local stack in one command:
// migrations, `wrangler dev`, a seeded workspace on first run, and the env
// file that the CLI and `pnpm otui` read.
//
//   pnpm dev:all                  port 8787, state in apps/server/.wrangler/state
//   pnpm dev:all --port 0         any free port (parallel worktrees)
//   pnpm dev:all --fresh          wipe the state first
//   pnpm dev:all --no-seed        an empty server
//   pnpm dev:all --web            also the app's Vite dev server, signed in to this one
//                                 (on a free port with --port 0, else 5173)
//   pnpm dev:all --app-url <url>  where permalinks (/archives/...) send the browser: by default
//                                 the --web app, else APP_URL in .dev.vars, else :5173 (pnpm web)
//
// While it runs, <state>/../campflare-dev.run.json says what it serves
// (scripts/dev-stack.ts): `pnpm shot` finds the app through it.

import { execFileSync, spawn, type ChildProcess } from "node:child_process"
import { copyFileSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { createServer } from "node:net"
import { dirname, join, resolve } from "node:path"
import { parseArgs } from "node:util"
import { removeStack, stackFile, writeStack } from "./dev-stack.ts"
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
    web: { type: "boolean", default: false },
    "app-url": { type: "string" },
  },
  allowNegative: true,
})

const state = resolve(values.state ?? join(server, ".wrangler/state"))
const seededFile = join(state, "campflare-dev.json")
/** Written each run (the port can change), read by the CLI and scripts/otui.sh. */
const envFile = join(dirname(state), "campflare-dev.env")
const runFile = stackFile(state)

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

async function answers(target: string, what: string) {
  for (let i = 0; ; i++) {
    try {
      if ((await fetch(target)).ok) return
    } catch {
      // not up yet
    }
    if (i > 240) throw new Error(`${what} did not answer on ${target}`)
    await new Promise((r) => setTimeout(r, 250))
  }
}

if (values.fresh) rmSync(state, { recursive: true, force: true })
const vars = devVars()
execFileSync(wrangler, ["d1", "migrations", "apply", "campflare", "--local", "--persist-to", state], {
  cwd: server,
  stdio: ["ignore", "ignore", "inherit"],
})

const port = values.port === "0" ? await freePort() : Number(values.port)
const url = `http://localhost:${port}`
// The app's port is chosen now, though it starts later: the server needs its URL (APP_URL) to redirect permalinks to.
const webPort = values.web ? (values.port === "0" ? await freePort() : 5173) : undefined
const appUrl = webPort ? `http://localhost:${webPort}` : undefined
const permalinkTarget = values["app-url"] ?? (appUrl ? `${appUrl}/` : vars.APP_URL || "http://localhost:5173/")
const children: ChildProcess[] = []
let stopping = false
// The inspector too: wrangler probes 9229 and takes the next free one, a race two stacks starting at once can lose.
const inspector = values.port === "0" ? ["--inspector-port", String(await freePort())] : []
const child = spawn(
  wrangler,
  ["dev", "--port", String(port), ...inspector, "--persist-to", state, "--var", `APP_URL:${permalinkTarget}`],
  { cwd: server, stdio: ["inherit", "inherit", "inherit"] },
)
children.push(child)
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, () => {
    stopping = true
    for (const c of children) c.kill(signal)
  })
process.on("exit", () => {
  removeStack(runFile)
  for (const c of children) if (c.exitCode === null && c.signalCode === null) c.kill("SIGTERM")
})
child.on("exit", (code) => process.exit(code ?? 0))

await answers(url, "wrangler dev")

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
    `SLACK_BOT_TOKEN=${seeded.botToken}`,
    // An app that takes events over HTTP: campflare admin app $CAMPFLARE_APP_ID --request-url <url>
    ...(seeded.appId ? [`CAMPFLARE_APP_ID=${seeded.appId}`] : []),
    ...(seeded.signingSecret ? [`SLACK_SIGNING_SECRET=${seeded.signingSecret}`] : []),
    ...Object.entries(seeded.people).map(([name, token]) => `CAMPFLARE_TOKEN_${name.toUpperCase()}=${token}`),
  )
}
writeFileSync(envFile, `# Written by pnpm dev:all; the tokens belong to ${state}\n${lines.join("\n")}\n`, {
  mode: 0o600,
})

// Vite reads the env file when it loads its config, so the app starts only now.
if (webPort && appUrl) {
  const web = join(root, "apps/web")
  const vite = spawn(join(web, "node_modules/.bin/vite"), ["--port", String(webPort), "--strictPort"], {
    cwd: web,
    env: { ...process.env, CAMPFLARE_DEV_ENV: envFile, CAMPFLARE_WEB_PORT: String(webPort) },
    stdio: ["ignore", "inherit", "inherit"],
  })
  children.push(vite)
  // One without the other is half a stack: stop both.
  vite.on("exit", (code) => {
    if (stopping) return
    stopping = true
    console.error(`the app's dev server stopped (${code ?? "signal"}); stopping the server too`)
    child.kill("SIGTERM")
  })
  await answers(appUrl, "the app's dev server")
}
writeStack(runFile, { apiUrl: url, ...(appUrl ? { appUrl } : {}), envFile, pid: process.pid })

const rel = (p: string) => p.replace(`${root}/`, "")
const custom = values.state ? `CAMPFLARE_DEV_ENV=${rel(envFile)} ` : ""
const stateArg = values.state ? ` --state ${rel(state)}` : ""
console.log(`
  Campflare is up on ${url}${appUrl ? `\n  app    ${appUrl}  (signed in as alex; ?as=vincent for someone else)` : ""}
  links  permalinks (/archives/...) open ${permalinkTarget}
  state  ${rel(state)}${seeded ? "\n  team   Campflare Dev: you are @alex; also vincent, minjun, ada" : ""}
  env    ${rel(envFile)}
  run    ${rel(runFile)}

  In another terminal:
    ${custom}pnpm otui                     # opentui-slack against this server${appUrl ? `\n    pnpm shot '#/<channel id>'${stateArg}   # screenshot, problems and outline of the app` : ""}
    set -a; . ${rel(envFile)}; set +a    # then the CLI acts as @alex:
    campflare send '#dev' "hello"
    CAMPFLARE_TOKEN=$CAMPFLARE_TOKEN_VINCENT campflare send @alex "hi"
`)
