#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import type { Io } from "./io"
import { run } from "./run"

const configPath = join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "campflare", "config.json")

const io: Io = {
  stdout: (text) => void process.stdout.write(text),
  stderr: (text) => void process.stderr.write(text),
  async stdin() {
    if (process.stdin.isTTY) return undefined
    const chunks: Buffer[] = []
    for await (const chunk of process.stdin) chunks.push(chunk as Buffer)
    return Buffer.concat(chunks).toString("utf8")
  },
  env: process.env,
  readFile: async (path) => new Uint8Array(await readFile(path)),
  readConfig: () => readFile(configPath, "utf8").catch(() => undefined),
  async writeConfig(text) {
    await mkdir(dirname(configPath), { recursive: true, mode: 0o700 })
    // Tokens live here: readable by you alone.
    await writeFile(configPath, text, { mode: 0o600 })
  },
  configPath,
  interrupted: () => new Promise((resolve) => process.once("SIGINT", () => resolve())),
}

process.exitCode = await run(process.argv.slice(2), io)
