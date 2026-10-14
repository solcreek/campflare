import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { imageSize, isAnimated } from "../../apps/server/src/api/media.ts"
import { makeGif } from "../../apps/server/test/gif.ts"
import { seed, sunsetPng, type Seeded } from "../../scripts/seed.ts"
import { startServer, type Server } from "../conformance/global-setup.ts"
import { devVars } from "./env.ts"

// Thumbnails from the real Cloudflare Images binding, not Miniflare's sharp
// stand-in (which can't write GIF): the Worker under wrangler dev with the
// binding set to remote, so wrangler proxies it to the account.

const env = devVars()
const configured = Boolean(env.CF_ACCOUNT_ID && env.IMAGES_API_TOKEN)

const SERVER = resolve(import.meta.dirname, "../../apps/server")

/** apps/server/wrangler.jsonc with the Images binding remote, written to a directory of its own. */
function remoteImagesConfig(dir: string, accountId: string) {
  const jsonc = readFileSync(join(SERVER, "wrangler.jsonc"), "utf8")
  // Its comments are whole lines; trailing commas go before JSON.parse.
  const config = JSON.parse(
    jsonc
      .split("\n")
      .filter((l) => !l.trim().startsWith("//"))
      .join("\n")
      .replaceAll(/,(\s*[}\]])/g, "$1"),
  )
  delete config.$schema
  config.account_id = accountId
  config.main = join(SERVER, config.main)
  for (const d1 of config.d1_databases) d1.migrations_dir = join(SERVER, d1.migrations_dir)
  config.images = { binding: "IMAGES", remote: true }
  const path = join(dir, "wrangler.json")
  writeFileSync(path, JSON.stringify(config, null, 2))
  return path
}

let dir: string
let server: Server
let team: Seeded

beforeAll(async () => {
  if (!configured) return
  dir = mkdtempSync(join(tmpdir(), "campflare-images-live-"))
  server = await startServer({
    config: remoteImagesConfig(dir, env.CF_ACCOUNT_ID!),
    env: { CLOUDFLARE_API_TOKEN: env.IMAGES_API_TOKEN!, CLOUDFLARE_ACCOUNT_ID: env.CF_ACCOUNT_ID! },
    timeoutMs: 120_000,
  })
  team = await seed(server.base, "conformance", `Images ${Date.now()}`)
}, 180_000)

afterAll(async () => {
  await server?.stop()
  if (dir) rmSync(dir, { recursive: true, force: true })
})

type FileJson = Record<string, unknown> & { id: string; url_private: string }

async function api<T>(method: string, args: Record<string, unknown>): Promise<T> {
  const res = await fetch(`${server.base}/api/${method}`, {
    method: "POST",
    headers: { authorization: `Bearer ${team.owner}`, "content-type": "application/json" },
    body: JSON.stringify(args),
  })
  const body = (await res.json()) as T & { ok: boolean; error?: string }
  if (!body.ok) throw new Error(`${method}: ${body.error}`)
  return body
}

async function share(name: string, bytes: Uint8Array<ArrayBuffer>) {
  const reserved = await api<{ upload_url: string; file_id: string }>("files.getUploadURLExternal", {
    filename: name,
    length: bytes.length,
  })
  expect((await fetch(reserved.upload_url, { method: "POST", body: bytes })).status).toBe(200)
  await api("files.completeUploadExternal", { files: [{ id: reserved.file_id }], channel_id: team.channels.general })
  return (await api<{ file: FileJson }>("files.info", { file: reserved.file_id })).file
}

async function fetchThumb(url: unknown) {
  const res = await fetch(url as string, { headers: { authorization: `Bearer ${team.owner}` } })
  expect(res.status).toBe(200)
  const bytes = new Uint8Array(await res.arrayBuffer())
  return { type: res.headers.get("content-type"), bytes, size: imageSize(bytes) }
}

/** Why the tests skip, as a skip note: vitest shows it beside each skipped test. */
const NEEDS =
  "set CF_ACCOUNT_ID and IMAGES_API_TOKEN in apps/server/.dev.vars or the environment (an account API token " +
  "with Workers Scripts: Edit and Images: Edit, for wrangler's remote Images binding)"

describe("Images binding (live)", () => {
  it("makes the still sizes of a PNG, squares cropped and padded", async ({ skip }) => {
    skip(!configured, NEEDS)
    const file = await share("sunset.png", await sunsetPng(1200, 900))
    for (const [field, width, height] of [
      ["thumb_64", 64, 64],
      ["thumb_80", 80, 80],
      ["thumb_360", 360, 270],
      ["thumb_1024", 1024, 768],
    ] as const) {
      const { type, size } = await fetchThumb(file[field])
      expect({ field, type, size }).toEqual({ field, type: "image/png", size: { width, height } })
    }
  })

  it("makes moving GIFs of an animated GIF, and a still first frame", async ({ skip }) => {
    skip(!configured, NEEDS)
    const original = makeGif(500, 400, 3)
    const file = await share("animación.gif", original)
    for (const [field, width, height] of [
      ["thumb_360_gif", 360, 288],
      ["thumb_480_gif", 480, 384],
    ] as const) {
      const { type, size, bytes } = await fetchThumb(file[field])
      // Made by Images (the original would stand in, at 500×400, if it failed), and still moving.
      expect({ field, type, size, animated: isAnimated(bytes) }).toEqual({
        field,
        type: "image/gif",
        size: { width, height },
        animated: true,
      })
    }
    const still = await fetchThumb(file.deanimate_gif)
    expect(still.type).toBe("image/png")
    expect(still.size).toEqual({ width: 500, height: 400 })
    const png = await fetchThumb(file.thumb_360)
    expect(png.type).toBe("image/png")
    expect(png.size).toEqual({ width: 360, height: 288 })
  })
})
