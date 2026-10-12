#!/usr/bin/env node
import { spawn } from "node:child_process"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import type { Io } from "./io"
import { run } from "./run"

const configPath = join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "campflare", "config.json")

/** A line typed at the terminal, not echoed: raw mode, so we see each key and print nothing. */
function readHidden(prompt: string): Promise<string> {
  const stdin = process.stdin
  process.stderr.write(prompt)
  stdin.setRawMode(true)
  stdin.setEncoding("utf8")
  stdin.resume()
  return new Promise((resolve) => {
    let line = ""
    const done = () => {
      stdin.off("data", onData)
      stdin.setRawMode(false)
      stdin.pause()
      process.stderr.write("\n")
    }
    const onData = (chunk: string) => {
      for (const char of chunk) {
        if (char === "\r" || char === "\n" || char === "\u0004") {
          done()
          return resolve(line)
        }
        if (char === "\u0003") {
          done()
          process.exit(130)
        }
        if (char === "\u007f" || char === "\b") line = [...line].slice(0, -1).join("")
        else line += char
      }
    }
    stdin.on("data", onData)
  })
}

const io: Io = {
  stdout: (text) => void process.stdout.write(text),
  stderr: (text) => void process.stderr.write(text),
  async stdin() {
    if (process.stdin.isTTY) return undefined
    const chunks: Buffer[] = []
    for await (const chunk of process.stdin) chunks.push(chunk as Buffer)
    return Buffer.concat(chunks).toString("utf8")
  },
  secret: process.stdin.isTTY ? readHidden : undefined,
  env: process.env,
  readFile: async (path) => new Uint8Array(await readFile(path)),
  readConfig: () => readFile(configPath, "utf8").catch(() => undefined),
  async writeConfig(text) {
    await mkdir(dirname(configPath), { recursive: true, mode: 0o700 })
    // Tokens live here: readable by you alone.
    await writeFile(configPath, text, { mode: 0o600 })
  },
  configPath,
  openUrl(url) {
    // Best effort: with no browser, the URL printed beside it still works.
    const [command, args] =
      process.platform === "darwin"
        ? ["open", [url]]
        : process.platform === "win32"
          ? ["rundll32", ["url.dll,FileProtocolHandler", url]]
          : ["xdg-open", [url]]
    spawn(command as string, args as string[], { stdio: "ignore", detached: true })
      .on("error", () => {})
      .unref()
  },
  interrupted: () => new Promise((resolve) => process.once("SIGINT", () => resolve())),
}

process.exitCode = await run(process.argv.slice(2), io)
