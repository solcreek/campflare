import { inject } from "vitest"
import type { Io } from "../src/io"
import { run } from "../src/run"

declare module "vitest" {
  export interface ProvidedContext {
    baseUrl: string
  }
}

export const baseUrl = inject("baseUrl")

/** An Io over memory: captured output, an in-memory config file, optional stdin and files. */
export function memoryIo(
  opts: {
    stdin?: string
    /**
     * Piped input in pieces, as `stream` reads it; each piece after the one before has been handled.
     * A generator can act between pieces (stop the stream, say).
     */
    stdinChunks?: string[] | (() => AsyncIterable<string>)
    files?: Record<string, string | Uint8Array>
    env?: Record<string, string>
    openUrl?: (url: string) => Promise<void>
    /** Answers to hidden terminal prompts, in order; none means no terminal. */
    secrets?: string[]
  } = {},
) {
  let config: string | undefined
  const out: string[] = []
  const err: string[] = []
  let interrupt: (() => void) | undefined
  const io: Io = {
    stdout: (t) => void out.push(t),
    stderr: (t) => void err.push(t),
    stdin: async () => opts.stdin,
    stdinChunks: opts.stdinChunks
      ? () => {
          const chunks = opts.stdinChunks!
          if (typeof chunks === "function") return chunks()
          return (async function* () {
            yield* chunks
          })()
        }
      : undefined,
    env: opts.env ?? {},
    async readFile(path) {
      const text = opts.files?.[path]
      if (text === undefined) throw new Error(`ENOENT: ${path}`)
      return typeof text === "string" ? new TextEncoder().encode(text) : new Uint8Array(text)
    },
    readConfig: async () => config,
    writeConfig: async (text) => void (config = text),
    configPath: "/memory/config.json",
    interrupted: () => new Promise((resolve) => (interrupt = resolve)),
    openUrl: opts.openUrl,
    secret: opts.secrets ? async () => opts.secrets!.shift() ?? "" : undefined,
  }
  return {
    io,
    get out() {
      return out.join("")
    },
    get err() {
      return err.join("")
    },
    get config() {
      return config
        ? (JSON.parse(config) as {
            current?: string
            profiles: Record<string, { url: string; token?: string; appToken?: string; via?: string }>
          })
        : undefined
    },
    clear() {
      out.length = 0
      err.length = 0
    },
    interrupt: () => interrupt?.(),
    /** Runs a command, returning its exit code. */
    run: (...argv: string[]) => run(argv, io),
  }
}

/** A fresh workspace, with `cli` logged in as its owner. Test files run at once, so its name is random. */
export async function loggedIn() {
  const cli = memoryIo()
  const code = await cli.run(
    "bootstrap",
    "--url",
    baseUrl,
    "--secret",
    "conformance",
    "--team",
    `CLI ${Date.now()} ${crypto.randomUUID().slice(0, 8)}`,
    "--user",
    "owner",
    "--name",
    "Olive Owner",
  )
  if (code !== 0) throw new Error(`bootstrap failed: ${cli.err}`)
  cli.clear()
  return cli
}
