import { spawnSync } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { afterEach, describe, expect, it } from "vitest"

// The Claude Code hooks in scripts/agent, run as Claude Code runs them: JSON on stdin.

const root = resolve(import.meta.dirname, "../..")
const hook = (script: string, input: unknown) =>
  spawnSync(join(root, "scripts/agent/node"), [join(root, "scripts/agent", script)], {
    cwd: root,
    input: JSON.stringify(input),
    encoding: "utf8",
  })

const probe = join(root, "tests/conformance/.hook-probe.ts")
const cssProbe = join(root, "tests/conformance/.hook-probe.css")
const tsxProbe = join(root, "tests/conformance/.hook-probe.tsx")
afterEach(() => {
  for (const p of [probe, cssProbe, tsxProbe]) rmSync(p, { force: true })
})

describe("after-edit", () => {
  it("formats the file it's told about", () => {
    writeFileSync(probe, "export const x = {a:1};;\n")
    const res = hook("after-edit.ts", { tool_input: { file_path: probe } })
    expect(res.status).toBe(0)
    expect(readFileSync(probe, "utf8")).toBe("export const x = { a: 1 }\n")
  })

  it("formats stylesheets too", () => {
    writeFileSync(cssProbe, ".a{color:red}\n")
    expect(hook("after-edit.ts", { tool_input: { file_path: cssProbe } }).status).toBe(0)
    expect(readFileSync(cssProbe, "utf8")).toBe(".a {\n  color: red;\n}\n")
  })

  it("catches React hook mistakes in components", () => {
    writeFileSync(
      tsxProbe,
      'import { useEffect } from "react"\nexport function A({ n }: { n: number }) {\n  useEffect(() => console.log(n), [])\n  return null\n}\n',
    )
    const res = hook("after-edit.ts", { tool_input: { file_path: tsxProbe } })
    expect(res.status).toBe(2)
    expect(res.stderr).toContain("exhaustive-deps")
  })

  it("hands lint errors back to the agent with exit 2", () => {
    writeFileSync(probe, "const unused = 1\nexport {}\n")
    const res = hook("after-edit.ts", { tool_input: { file_path: probe } })
    expect(res.status).toBe(2)
    expect(res.stderr).toContain("no-unused-vars")
  })

  it("hands warnings back too: pnpm check denies them", () => {
    writeFileSync(probe, "export const a = 1\nexport function f() {\n  const a = 2\n  return a\n}\n")
    const res = hook("after-edit.ts", { tool_input: { file_path: probe } })
    expect(res.status).toBe(2)
    expect(res.stderr).toContain("no-shadow")
  })

  it("leaves files outside the repo, in node_modules, or of other kinds alone", () => {
    const dir = mkdtempSync(join(tmpdir(), "hook-"))
    const outside = join(dir, "x.ts")
    writeFileSync(outside, "const   x=1\n")
    expect(hook("after-edit.ts", { tool_input: { file_path: outside } }).status).toBe(0)
    expect(readFileSync(outside, "utf8")).toBe("const   x=1\n")
    rmSync(dir, { recursive: true })
    expect(
      hook("after-edit.ts", { tool_input: { file_path: join(root, "node_modules/vitest/package.json") } }).status,
    ).toBe(0)
    expect(hook("after-edit.ts", { tool_input: { file_path: join(root, "flake.nix") } }).status).toBe(0)
    expect(hook("after-edit.ts", {}).status).toBe(0)
  })
})

describe("before-stop", () => {
  it("never blocks twice in a row", () => {
    expect(hook("before-stop.ts", { stop_hook_active: true }).status).toBe(0)
  })
})
