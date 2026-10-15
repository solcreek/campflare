// pnpm vapid-keys — a fresh VAPID key pair for Web Push (docs/push.md), in
// the encoding the server reads (and the web-push tools print): the public
// key's uncompressed point and the private scalar d, base64url.
//
//   pnpm vapid-keys                              prints them, for `wrangler secret put`
//   pnpm vapid-keys --write apps/server/.dev.vars    sets them in that file (what `pnpm ready --fix` runs)

import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { parseArgs } from "node:util"

export interface VapidKeys {
  VAPID_PUBLIC_KEY: string
  VAPID_PRIVATE_KEY: string
}

export async function generateVapidKeys(): Promise<VapidKeys> {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])
  const raw = Buffer.from(await crypto.subtle.exportKey("raw", pair.publicKey))
  const jwk = await crypto.subtle.exportKey("jwk", pair.privateKey)
  return { VAPID_PUBLIC_KEY: raw.toString("base64url"), VAPID_PRIVATE_KEY: jwk.d! }
}

/** The .dev.vars text with the keys set: an existing line (empty or not) replaced, else added at the end. */
export function withVapidKeys(text: string, keys: VapidKeys): string {
  let out = text
  for (const [name, value] of Object.entries(keys)) {
    const line = new RegExp(`^\\s*${name}\\s*=.*$`, "m")
    out = line.test(out)
      ? out.replace(line, `${name}=${value}`)
      : `${out}${out && !out.endsWith("\n") ? "\n" : ""}${name}=${value}\n`
  }
  return out
}

if (import.meta.main) {
  const { values } = parseArgs({ options: { write: { type: "string" } } })
  const keys = await generateVapidKeys()
  if (values.write) {
    const path = values.write
    writeFileSync(path, withVapidKeys(existsSync(path) ? readFileSync(path, "utf8") : "", keys))
    console.log(`VAPID keys written to ${path}`)
  } else {
    for (const [name, value] of Object.entries(keys)) console.log(`${name}=${value}`)
  }
}
