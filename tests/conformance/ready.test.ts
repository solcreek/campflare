import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
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
} from "../../scripts/ready-checks.ts"

// `pnpm ready`'s checks, against a scratch checkout: never the real one.

let root: string
const write = (path: string, text = "", mtime?: number) => {
  const full = join(root, path)
  mkdirSync(dirname(full), { recursive: true })
  writeFileSync(full, text)
  if (mtime) utimesSync(full, mtime / 1000, mtime / 1000)
}

afterEach(() => rmSync(root, { recursive: true, force: true }))
const scratch = () => (root = mkdtempSync(join(tmpdir(), "campflare-ready-")))

describe("pnpm ready checks", () => {
  it("compares Node and pnpm with what the repo pins", () => {
    scratch()
    write(".node-version", "24\n")
    write("package.json", JSON.stringify({ packageManager: "pnpm@10.14.0" }))
    expect(nodeVersion(root, "24.21.0")).toMatchObject({ ok: true, detail: "v24.21.0" })
    expect(nodeVersion(root, "22.1.0")).toMatchObject({ ok: false, detail: "v22.1.0 on PATH, .node-version wants 24" })
    expect(pnpmVersion(root, "10.14.0").ok).toBe(true)
    expect(pnpmVersion(root, "9.0.0")).toMatchObject({ ok: false, detail: "9.0.0, package.json wants 10.14.0" })
    expect(pnpmVersion(root, undefined).detail).toBe("not found, package.json wants 10.14.0")
  })

  it("knows when node_modules doesn't match the lockfile", () => {
    scratch()
    expect(dependencies(root)).toMatchObject({ ok: false, detail: "not installed", fix: "pnpm install" })
    write("pnpm-lock.yaml", "a")
    write("node_modules/.pnpm/lock.yaml", "b")
    expect(dependencies(root)).toMatchObject({ ok: false, detail: "node_modules is older than pnpm-lock.yaml" })
    write("node_modules/.pnpm/lock.yaml", "a")
    expect(dependencies(root).ok).toBe(true)
  })

  it("wants both local secrets, and copies the example when there's no file", () => {
    scratch()
    expect(devVars(root)).toMatchObject({ ok: false, fix: "cp apps/server/.dev.vars.example apps/server/.dev.vars" })
    write("apps/server/.dev.vars", "SIGNING_KEY=x\nBOOTSTRAP_SECRET=\n")
    // A file with a gap can't be fixed by copying over it: say what's missing.
    expect(devVars(root)).toMatchObject({
      ok: false,
      detail: "apps/server/.dev.vars lacks BOOTSTRAP_SECRET",
      fix: undefined,
    })
    write("apps/server/.dev.vars", "SIGNING_KEY=x\nBOOTSTRAP_SECRET=y\n")
    expect(devVars(root).ok).toBe(true)
  })

  it("spots bundles older than their sources, the CLI's including the client's", () => {
    scratch()
    const t = Date.now()
    write("packages/client/src/index.ts", "", t - 10_000)
    write("packages/client/dist/index.js", "", t - 5_000)
    write("apps/cli/src/run.ts", "", t - 10_000)
    write("apps/cli/dist/index.mjs", "", t - 5_000)
    expect(bundles(root).ok).toBe(true)
    // A client change makes both stale: the CLI bundles the client in.
    write("packages/client/src/follow.ts", "", t)
    expect(bundles(root)).toMatchObject({
      ok: false,
      detail: "packages/client and apps/cli built before their sources changed",
      fix: "pnpm build",
    })
  })

  it("lists unapplied migrations through wrangler", () => {
    scratch()
    expect(migrations(root)).toMatchObject({ ok: false, detail: "wrangler isn't installed" })
    write("apps/server/node_modules/.bin/wrangler")
    const pending = (() =>
      "│ 0003_better_auth.sql │\n│ 0004_next.sql │") as unknown as typeof import("node:child_process").execFileSync
    expect(migrations(root, pending)).toMatchObject({
      ok: false,
      detail: "2 migrations to apply: 0003_better_auth.sql, 0004_next.sql",
    })
    const none = (() => "✅ No migrations to apply!") as unknown as typeof import("node:child_process").execFileSync
    expect(migrations(root, none).ok).toBe(true)
    const broken = (() => {
      throw new Error("boom\nstack")
    }) as unknown as typeof import("node:child_process").execFileSync
    expect(migrations(root, broken).detail).toBe("couldn't list migrations: boom")
  })

  it("tells our dev server from something else on the port, without failing", async () => {
    const ours = (async () => Response.json({ name: "campflare" })) as typeof fetch
    const theirs = (async () => new Response("<html>")) as typeof fetch
    const nobody = (async () => {
      throw new Error("ECONNREFUSED")
    }) as typeof fetch
    expect(await devPort(8787, ours)).toMatchObject({
      ok: true,
      advisory: true,
      detail: "Campflare is running on :8787",
    })
    expect(await devPort(8787, theirs)).toMatchObject({ ok: false, advisory: true })
    expect(await devPort(8787, nobody)).toMatchObject({ ok: true, detail: ":8787 is free (pnpm dev:all starts one)" })
  })

  it("finds opentui-slack by its declared entry, and notes where Node comes from", () => {
    scratch()
    expect(opentuiSlack(root, { OPENTUI_SLACK_REPO: join(root, "otui") }).ok).toBe(false)
    write("otui/package.json", JSON.stringify({ module: "src/index.ts" }))
    write("otui/src/index.ts")
    expect(opentuiSlack(root, { OPENTUI_SLACK_REPO: join(root, "otui") })).toMatchObject({ ok: true, advisory: true })
    expect(toolchainSource("/nix/store/abc-nodejs-24/bin/node").ok).toBe(true)
    expect(toolchainSource("/usr/local/bin/node")).toMatchObject({ ok: false, advisory: true })
  })
})
