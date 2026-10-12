// The checks behind `pnpm ready`: each looks at one thing a local stack needs,
// says what's wrong in a line, and (where it can) knows the command that fixes
// it. They take the repo root as an argument so tests can point them elsewhere.

import { execFileSync } from "node:child_process"
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"

export interface Check {
  name: string
  ok: boolean
  detail: string
  /** A shell command that fixes it, run from the repo root by `pnpm ready --fix`. */
  fix?: string
  /** Informational: never fails `pnpm ready`. */
  advisory?: boolean
}

const read = (path: string) => (existsSync(path) ? readFileSync(path, "utf8") : undefined)

export function nodeVersion(root: string, running = process.versions.node): Check {
  const want = read(join(root, ".node-version"))?.trim()
  const have = running.split(".")[0]
  return {
    name: "node",
    ok: want === have,
    detail: want === have ? `v${running}` : `v${running} on PATH, .node-version wants ${want ?? "(missing)"}`,
    fix: want === have ? undefined : "nix develop  # or put Node ${want} on PATH",
  }
}

export function pnpmVersion(root: string, running: string | undefined): Check {
  const pkg = JSON.parse(read(join(root, "package.json")) ?? "{}") as { packageManager?: string }
  const want = pkg.packageManager?.replace(/^pnpm@/, "")
  const ok = Boolean(running) && running === want
  return {
    name: "pnpm",
    ok,
    detail: ok ? running! : `${running ?? "not found"}, package.json wants ${want}`,
    fix: ok ? undefined : `corepack enable  # or nix develop`,
  }
}

/** pnpm keeps a copy of the lockfile it installed from: if it differs, node_modules is stale. */
export function dependencies(root: string): Check {
  const lock = read(join(root, "pnpm-lock.yaml"))
  const installed = read(join(root, "node_modules/.pnpm/lock.yaml"))
  const ok = Boolean(lock && installed && lock === installed)
  return {
    name: "dependencies",
    ok,
    detail: ok
      ? "installed, matching pnpm-lock.yaml"
      : installed
        ? "node_modules is older than pnpm-lock.yaml"
        : "not installed",
    fix: ok ? undefined : "pnpm install",
  }
}

export function devVars(root: string): Check {
  const path = join(root, "apps/server/.dev.vars")
  const text = read(path)
  const missing = ["SIGNING_KEY", "BOOTSTRAP_SECRET"].filter(
    (k) => !text || !new RegExp(`^\\s*${k}\\s*=\\s*\\S`, "m").test(text),
  )
  return {
    name: "secrets",
    ok: missing.length === 0,
    detail:
      missing.length === 0
        ? "apps/server/.dev.vars"
        : text
          ? `apps/server/.dev.vars lacks ${missing.join(", ")}`
          : "no apps/server/.dev.vars",
    fix: text ? undefined : "cp apps/server/.dev.vars.example apps/server/.dev.vars",
  }
}

function newest(dir: string, matches: (name: string) => boolean): number {
  let latest = 0
  if (!existsSync(dir)) return 0
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) latest = Math.max(latest, newest(path, matches))
    else if (matches(entry.name)) latest = Math.max(latest, statSync(path).mtimeMs)
  }
  return latest
}

/**
 * A bundle older than its sources hides new code from whatever runs it (the
 * `campflare` wrapper runs apps/cli/dist). The CLI bundles the client in, so
 * it is stale when either source is newer.
 */
const isTs = (name: string) => name.endsWith(".ts")

export function bundles(root: string): Check {
  const client = newest(join(root, "packages/client/src"), isTs)
  const cli = Math.max(client, newest(join(root, "apps/cli/src"), isTs))
  const built = {
    client: newest(join(root, "packages/client/dist"), () => true),
    cli: newest(join(root, "apps/cli/dist"), () => true),
  }
  const stale = [built.client < client ? "packages/client" : "", built.cli < cli ? "apps/cli" : ""].filter(Boolean)
  return {
    name: "bundles",
    ok: stale.length === 0,
    detail:
      stale.length === 0
        ? "client and CLI builds are current"
        : `${stale.join(" and ")} built before their sources changed`,
    fix: stale.length === 0 ? undefined : "pnpm build",
  }
}

/** Migrations not yet applied to the local D1 (wrangler's own bookkeeping). */
export function migrations(root: string, run = execFileSync): Check {
  const server = join(root, "apps/server")
  const wrangler = join(server, "node_modules/.bin/wrangler")
  if (!existsSync(wrangler))
    return { name: "database", ok: false, detail: "wrangler isn't installed", fix: "pnpm install" }
  let out: string
  try {
    out = String(
      run(wrangler, ["d1", "migrations", "list", "campflare", "--local"], {
        cwd: server,
        stdio: ["ignore", "pipe", "pipe"],
      }),
    )
  } catch (error) {
    return {
      name: "database",
      ok: false,
      detail: `couldn't list migrations: ${error instanceof Error ? error.message.split("\n")[0] : error}`,
    }
  }
  const pending = [...out.matchAll(/(\d{4}_[\w-]+\.sql)/g)].map((m) => m[1]!)
  return {
    name: "database",
    ok: pending.length === 0,
    detail:
      pending.length === 0
        ? "local D1 has every migration"
        : `${pending.length} migration${pending.length === 1 ? "" : "s"} to apply: ${pending.join(", ")}`,
    fix: pending.length === 0 ? undefined : "pnpm --filter @campflare/server db:migrate:local",
  }
}

/** Whether something already answers on the dev port, and whether it's us. */
export async function devPort(port = 8787, fetcher: typeof fetch = fetch): Promise<Check> {
  try {
    const res = await fetcher(`http://localhost:${port}/`, { signal: AbortSignal.timeout(1000) })
    const body = (await res.json().catch(() => ({}))) as { name?: string }
    return body.name === "campflare"
      ? { name: "dev server", ok: true, advisory: true, detail: `Campflare is running on :${port}` }
      : {
          name: "dev server",
          ok: false,
          advisory: true,
          detail: `something else answers on :${port}: use pnpm dev:all --port 0`,
        }
  } catch {
    return { name: "dev server", ok: true, advisory: true, detail: `:${port} is free (pnpm dev:all starts one)` }
  }
}

export function opentuiSlack(home: string, env: Record<string, string | undefined>): Check {
  const repo = env.OPENTUI_SLACK_REPO ?? join(home, "Projects/solcreek/opentui-slack")
  // Its entry is whatever its package.json says (scripts/otui.sh runs the same).
  const entry = (JSON.parse(read(join(repo, "package.json")) ?? "{}") as { module?: string }).module
  const ok = Boolean(entry && existsSync(join(repo, entry)))
  return {
    name: "opentui-slack",
    ok,
    advisory: true,
    detail: ok ? `${repo} (for pnpm otui)` : `not at ${repo}: pnpm otui needs it (or OPENTUI_SLACK_REPO)`,
  }
}

/** Whether the tools come from the flake: not required, but it's what keeps machines alike. */
export function toolchainSource(execPath = process.execPath): Check {
  const fromNix = execPath.startsWith("/nix/store/")
  return {
    name: "toolchain",
    ok: fromNix,
    advisory: true,
    detail: fromNix ? "from the Nix flake" : `Node from ${execPath} (nix develop gives the pinned toolchain)`,
  }
}
