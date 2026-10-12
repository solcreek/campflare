// The parts of `pnpm shot` that don't need a browser: its command line, where
// the app is, and what it prints. Pure, so tests/shot.test.ts checks them
// without a stack; scripts/shot.ts does the browsing.

import { resolve } from "node:path"
import { parseArgs } from "node:util"
import { chooseStackFile, readStack, type DevStack } from "../../../scripts/dev-stack.ts"

export type Step = { kind: "click" | "type" | "press"; value: string }

export interface ShotOptions {
  url?: string
  state?: string
  as?: string
  out: string
  width: number
  height: number
  dark: boolean
  wait: number
  /** URL hashes to open, one screenshot each; [""] for the app's start. */
  routes: string[]
  /** --click, --type and --press in the order they were given. */
  steps: Step[]
}

/** Thrown for a command line shot can't run; its message says what to change. */
export class UsageError extends Error {}

/** A whole number of pixels or milliseconds, at least `min`. */
const number = (name: string, text: string, min: number) => {
  const n = Number(text)
  if (text.trim() === "" || !Number.isInteger(n) || n < min)
    throw new UsageError(`--${name} wants a whole number from ${min}, not "${text}"`)
  return n
}

export function parseShotArgs(args: string[]): ShotOptions {
  let parsed
  try {
    parsed = parseArgs({
      args,
      allowPositionals: true,
      tokens: true,
      options: {
        url: { type: "string" },
        state: { type: "string" },
        as: { type: "string" },
        out: { type: "string", default: ".shots/shot.png" },
        width: { type: "string", default: "1280" },
        height: { type: "string", default: "800" },
        dark: { type: "boolean", default: false },
        wait: { type: "string", default: "1500", short: "w" },
        click: { type: "string", multiple: true },
        type: { type: "string", multiple: true },
        press: { type: "string", multiple: true },
      },
    })
  } catch (error) {
    throw new UsageError((error as Error).message)
  }
  const { values, positionals, tokens } = parsed
  const steps: Step[] = tokens.flatMap((t) =>
    t.kind === "option" && (t.name === "click" || t.name === "type" || t.name === "press") && t.value !== undefined
      ? [{ kind: t.name, value: t.value }]
      : [],
  )
  // A malformed target fails before a browser starts, not after the wait.
  for (const step of steps) if (step.kind === "click") clickTarget(step.value)
  return {
    ...(values.url !== undefined ? { url: values.url } : {}),
    ...(values.state !== undefined ? { state: values.state } : {}),
    ...(values.as !== undefined ? { as: values.as } : {}),
    out: values.out,
    width: number("width", values.width, 1),
    height: number("height", values.height, 1),
    dark: values.dark,
    wait: number("wait", values.wait, 0),
    routes: positionals.length ? positionals : [""],
    steps,
  }
}

/** "button:Send" → role and accessible name. The name may hold colons ("link:https://…"). */
export function clickTarget(value: string): { role: string; name: string } {
  const colon = value.indexOf(":")
  if (colon < 1) throw new UsageError(`--click wants "<role>:<accessible name>", e.g. "button:Send", not "${value}"`)
  return { role: value.slice(0, colon), name: value.slice(colon + 1) }
}

/**
 * The app's URL: --url, then CAMPFLARE_WEB_PORT, then the run file of the
 * stack --state or CAMPFLARE_DEV_ENV names (or the repo's default). Without
 * one, `error` says how to get one.
 */
export function findApp(
  options: Pick<ShotOptions, "url" | "state">,
  {
    root,
    cwd,
    env,
    read = readStack,
  }: { root: string; cwd: string; env: NodeJS.ProcessEnv; read?: (file: string) => DevStack | null },
): { url: string } | { error: string } {
  if (options.url) return { url: options.url.replace(/\/$/, "") }
  if (env.CAMPFLARE_WEB_PORT) return { url: `http://localhost:${env.CAMPFLARE_WEB_PORT}` }
  const file = chooseStackFile(root, options.state && resolve(cwd, options.state), env.CAMPFLARE_DEV_ENV)
  const stack = read(file)
  if (!stack)
    return {
      error: `No dev stack is running (no live ${file.replace(`${root}/`, "")}).
Start one:  pnpm dev:all --port 0 --web    (add --state <dir> for a separate one, then shot --state <dir>)
or point at an app:  pnpm shot --url http://localhost:<port>`,
    }
  if (!stack.appUrl)
    return { error: `The dev stack on ${stack.apiUrl} (pid ${stack.pid}) runs without the app: restart it with --web.` }
  return { url: stack.appUrl }
}

/** The page for a route, signed in as --as when given. */
export const pageUrl = (base: string, as: string | undefined, route: string) =>
  `${base}/${as ? `?as=${as}` : ""}${route}`

/** The browser page's viewport and theme. */
export const pageOptions = (o: Pick<ShotOptions, "width" | "height" | "dark">) => ({
  viewport: { width: o.width, height: o.height },
  colorScheme: o.dark ? ("dark" as const) : ("light" as const),
})

/** shot.png, then shot-2.png, shot-3.png… for further routes. */
export const outFor = (out: string, i: number) => (i === 0 ? out : out.replace(/(\.\w+)?$/, (ext) => `-${i + 1}${ext}`))

/** How a step that failed reads among the problems: its flag, value and the error's first line. */
export const stepProblem = (step: Step, error: unknown) =>
  `--${step.kind} ${step.value}: ${error instanceof Error ? error.message.split("\n")[0] : error}`

/** What shot says on stderr, before exiting 1, when steps failed (each with its route). */
export const failedSteps = (failed: string[]) =>
  `shot: ${failed.length === 1 ? "a step" : `${failed.length} steps`} failed\n  ${failed.join("\n  ")}`

/** What shot prints for one route (a blank line before every route after the first). */
export function report(
  i: number,
  { out, url, problems, outline }: { out: string; url: string; problems: string[]; outline: string },
): string {
  return [
    ...(i > 0 ? [""] : []),
    `screenshot  ${out}  (${url})`,
    problems.length ? `problems\n  ${problems.join("\n  ")}` : "problems    none",
    `outline\n${outline}`,
  ].join("\n")
}
