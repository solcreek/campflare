import { existsSync, readFileSync } from "node:fs"
import { resolve } from "node:path"

/** apps/server/.dev.vars, where the Realtime credentials live locally; the environment wins. */
export function devVars(): Record<string, string | undefined> {
  const path = resolve(import.meta.dirname, "../../apps/server/.dev.vars")
  const file = existsSync(path)
    ? Object.fromEntries(
        readFileSync(path, "utf8")
          .split("\n")
          .flatMap((l) => {
            const m = l.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/)
            return m ? [[m[1]!, m[2]!]] : []
          }),
      )
    : {}
  return { ...file, ...process.env }
}
