import type { Fetch } from "@campflare/client"

/** Everything the CLI touches outside itself, so tests can stand in for it. */
export interface Io {
  stdout(text: string): void
  stderr(text: string): void
  /** Piped input, or undefined when stdin is a terminal. */
  stdin(): Promise<string | undefined>
  env: Record<string, string | undefined>
  readFile(path: string): Promise<Uint8Array<ArrayBuffer>>
  readConfig(): Promise<string | undefined>
  writeConfig(text: string): Promise<void>
  configPath: string
  fetch?: Fetch
  WebSocket?: typeof globalThis.WebSocket
  /** Opens a URL in the user's browser, if there is one to open. */
  openUrl?(url: string): void | Promise<void>
  /** Resolves when the user interrupts (Ctrl-C), for long-running commands. */
  interrupted(): Promise<void>
}

/** A usage mistake: exit code 2. */
export class UsageError extends Error {}
