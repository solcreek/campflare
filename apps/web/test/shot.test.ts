import { describe, expect, it } from "vitest"
import type { DevStack } from "../../../scripts/dev-stack.ts"
import {
  clickTarget,
  failedSteps,
  findApp,
  outFor,
  pageOptions,
  pageUrl,
  parseShotArgs,
  report,
  resolveRoute,
  stepProblem,
  UsageError,
} from "../scripts/shot-options.ts"

// `pnpm shot` without a browser: its command line, finding the app, and what it
// prints. tests/conformance/shot.test.ts runs the whole thing against a stack.

describe("shot's command line", () => {
  it("has defaults that open the app's start once", () => {
    expect(parseShotArgs([])).toEqual({
      out: ".shots/shot.png",
      width: 1280,
      height: 800,
      dark: false,
      wait: 1500,
      routes: [""],
      steps: [],
    })
  })

  it("takes several routes, one screenshot each", () => {
    const o = parseShotArgs(["#/C1", "#/C2", "#/C3/1700000000.000100"])
    expect(o.routes).toEqual(["#/C1", "#/C2", "#/C3/1700000000.000100"])
    expect(o.routes.map((_, i) => outFor(o.out, i))).toEqual([
      ".shots/shot.png",
      ".shots/shot-2.png",
      ".shots/shot-3.png",
    ])
    expect(outFor("/tmp/look", 1)).toBe("/tmp/look-2")
    expect(outFor("a.b/c.jpeg", 2)).toBe("a.b/c-3.jpeg")
  })

  it("keeps --click, --type and --press in the order given, interleaved", () => {
    const o = parseShotArgs([
      "#/C1",
      "--click",
      "textbox:Message #general",
      "--type",
      "早安 こんにちは 안녕",
      "--press",
      "Enter",
      "--type",
      "¿Qué tal? Ça va. Grüße",
      "--click",
      "button:Send",
    ])
    expect(o.steps).toEqual([
      { kind: "click", value: "textbox:Message #general" },
      { kind: "type", value: "早安 こんにちは 안녕" },
      { kind: "press", value: "Enter" },
      { kind: "type", value: "¿Qué tal? Ça va. Grüße" },
      { kind: "click", value: "button:Send" },
    ])
    expect(o.routes).toEqual(["#/C1"])
  })

  it("maps --as to the sign-in query and --dark to the colour scheme", () => {
    const o = parseShotArgs(["#/C1", "--as", "vincent", "--dark", "--width", "900", "--height", "600", "-w", "0"])
    expect(pageUrl("http://localhost:4200", o.as, o.routes[0]!)).toBe("http://localhost:4200/?as=vincent#/C1")
    expect(pageUrl("http://localhost:4200", undefined, "")).toBe("http://localhost:4200/")
    expect(pageOptions(o)).toEqual({ viewport: { width: 900, height: 600 }, colorScheme: "dark" })
    expect(pageOptions(parseShotArgs([])).colorScheme).toBe("light")
    expect(o.wait).toBe(0)
  })

  it("refuses what it can't run, saying what's wrong", () => {
    const bad: [string[], RegExp][] = [
      [["--bogus"], /Unknown option '--bogus'/],
      [["--as"], /--as.*argument missing/],
      [["--width", "wide"], /--width wants a whole number from 1, not "wide"/],
      [["--height", "0"], /--height wants a whole number from 1/],
      [["--wait=-5"], /--wait wants a whole number from 0/],
      [["--wait", ""], /--wait wants/],
      [["--click", "Send"], /--click wants "<role>:<accessible name>", e.g. "button:Send", not "Send"/],
      [["--click", ":Send"], /not ":Send"/],
    ]
    for (const [args, message] of bad) {
      const error = (() => {
        try {
          parseShotArgs(args)
        } catch (e) {
          return e
        }
      })()
      expect(error).toBeInstanceOf(UsageError)
      expect(`${args.join(" ")} → ${(error as Error).message}`).toMatch(message)
    }
  })
})

describe("a click target", () => {
  it("is a role, then everything after the first colon as the name", () => {
    expect(clickTarget("button:Send")).toEqual({ role: "button", name: "Send" })
    expect(clickTarget("link:https://example.com/ü")).toEqual({ role: "link", name: "https://example.com/ü" })
    expect(clickTarget("textbox:")).toEqual({ role: "textbox", name: "" })
  })
})

describe("a permalink as a route", () => {
  const link = "http://localhost:4100/archives/C1/p1700000000000200?thread_ts=1700000000.000100&cid=C1"
  const answering =
    (status: number, location?: string): typeof fetch =>
    async (_url, init) => {
      expect(init?.redirect).toBe("manual")
      return new Response(null, { status, headers: location ? { location } : {} })
    }

  it("is the hash its server redirects to; a hash stays as it is", async () => {
    const to = "http://localhost:4200/#/C1/1700000000.000100?msg=1700000000.000200"
    expect(await resolveRoute(link, answering(302, to))).toBe("#/C1/1700000000.000100?msg=1700000000.000200")
    expect(await resolveRoute("#/C1", answering(500))).toBe("#/C1")
    expect(await resolveRoute("", answering(500))).toBe("")
  })

  it("says why when the server doesn't redirect, or can't be reached", async () => {
    await expect(resolveRoute(link, answering(200))).rejects.toThrow(/answered HTTP 200, not a redirect/)
    await expect(resolveRoute(link, answering(404))).rejects.toBeInstanceOf(UsageError)
    const down: typeof fetch = () => Promise.reject(new TypeError("fetch failed"))
    await expect(resolveRoute(link, down)).rejects.toThrow(`couldn't reach ${link}: fetch failed`)
  })
})

describe("finding the app", () => {
  const root = "/repo"
  const live: DevStack = { apiUrl: "http://localhost:4100", appUrl: "http://localhost:4200", envFile: "/x.env", pid: 7 }
  const files: string[] = []
  const reading = (stack: DevStack | null) => (file: string) => (files.push(file), stack)

  it("takes --url, then CAMPFLARE_WEB_PORT, before any run file", () => {
    const read = reading(live)
    expect(findApp({ url: "http://localhost:3000/" }, { root, cwd: root, env: {}, read })).toEqual({
      url: "http://localhost:3000",
    })
    expect(findApp({}, { root, cwd: root, env: { CAMPFLARE_WEB_PORT: "3001" }, read })).toEqual({
      url: "http://localhost:3001",
    })
    expect(files).toEqual([])
  })

  it("reads the run file of --state (from where the command was typed), CAMPFLARE_DEV_ENV, or the default", () => {
    files.length = 0
    const read = reading(live)
    expect(findApp({ state: "s/state" }, { root, cwd: "/work", env: {}, read })).toEqual({ url: live.appUrl })
    findApp({}, { root, cwd: "/work", env: { CAMPFLARE_DEV_ENV: "/c/campflare-dev.env" }, read })
    findApp({}, { root, cwd: "/work", env: {}, read })
    expect(files).toEqual([
      "/work/s/campflare-dev.run.json",
      "/c/campflare-dev.run.json",
      "/repo/apps/server/.wrangler/campflare-dev.run.json",
    ])
  })

  it("says how to start a stack when there is none", () => {
    const found = findApp({}, { root, cwd: root, env: {}, read: () => null })
    expect(found).toEqual({ error: expect.stringContaining("No dev stack is running") })
    const { error } = found as { error: string }
    expect(error).toContain("no live apps/server/.wrangler/campflare-dev.run.json")
    expect(error).toContain("pnpm dev:all --port 0 --web")
    expect(error).toContain("pnpm shot --url http://localhost:<port>")
  })

  it("says to restart with --web when the stack has no app", () => {
    const { appUrl: _, ...apiOnly } = live
    expect(findApp({}, { root, cwd: root, env: {}, read: () => apiOnly })).toEqual({
      error: "The dev stack on http://localhost:4100 (pid 7) runs without the app: restart it with --web.",
    })
  })

  it("reads real run files by default (none here)", () => {
    expect(findApp({ state: "/nowhere/state" }, { root, cwd: root, env: {} })).toEqual({
      error: expect.stringContaining("no live /nowhere/campflare-dev.run.json"),
    })
  })
})

describe("what shot prints", () => {
  const outline = '- log "Messages"\n- textbox "Message #general"'

  it("is the screenshot, its problems or none, and the outline", () => {
    expect(report(0, { out: ".shots/shot.png", url: "http://a/#/C1", problems: [], outline })).toBe(
      `screenshot  .shots/shot.png  (http://a/#/C1)\nproblems    none\noutline\n${outline}`,
    )
  })

  it("lists problems indented and separates later routes by a blank line", () => {
    const problems = [
      "HTTP 404: http://a/x",
      stepProblem({ kind: "click", value: "button:Nope" }, new Error("Timeout\nmore")),
    ]
    expect(report(1, { out: "s-2.png", url: "http://a/", problems, outline: "-" })).toBe(
      "\nscreenshot  s-2.png  (http://a/)\nproblems\n  HTTP 404: http://a/x\n  --click button:Nope: Timeout\noutline\n-",
    )
    expect(stepProblem({ kind: "press", value: "Nope" }, "odd")).toBe("--press Nope: odd")
  })

  it("sums up failed steps for stderr", () => {
    expect(failedSteps(["--click button:Nope: Timeout (#/C1)"])).toBe(
      "shot: a step failed\n  --click button:Nope: Timeout (#/C1)",
    )
    expect(failedSteps(["--click a:b: x (start)", "--press Nope: y (#/C2)"])).toBe(
      "shot: 2 steps failed\n  --click a:b: x (start)\n  --press Nope: y (#/C2)",
    )
  })
})
