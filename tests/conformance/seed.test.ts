import { WebClient, LogLevel } from "@slack/web-api"
import { expect, inject, it } from "vitest"
import { seed } from "../../scripts/seed.ts"

// The workspace `pnpm dev:all` creates, read back through the official SDK.
it("seeds a workspace a Slack client can read", async () => {
  const base = inject("baseUrl")
  const seeded = await seed(base, "conformance", `Seed ${Date.now()}`)
  const web = new WebClient(seeded.owner, { slackApiUrl: `${base}/api/`, logLevel: LogLevel.ERROR })
  expect(Object.keys(seeded.people).toSorted()).toEqual(["ada", "minjun", "vincent"])
  expect(seeded.appToken).toMatch(/^xapp-/)
  expect(seeded.botToken).toMatch(/^xoxb-/)
  const dev = await web.conversations.history({ channel: seeded.channels.dev! })
  expect(dev.messages?.map((m) => m.text)).toContain("✅ build #128 passed on main (2m 14s)")
  const world = await web.conversations.history({ channel: seeded.channels.world! })
  // One greeting in each of seven languages (joins and the purpose change carry a subtype).
  expect(world.messages?.filter((m) => !m.subtype)).toHaveLength(7)
  // A message with an image, whose bytes are a real PNG of the size the server measured.
  const general = await web.conversations.history({ channel: seeded.channels.general! })
  const file = general.messages?.flatMap((m) => m.files ?? []).find((f) => f.name === "sunset.png")
  expect(file).toMatchObject({
    mimetype: "image/png",
    title: "Sunset from the campsite",
    original_w: 192,
    original_h: 128,
  })
  const png = await fetch(file!.url_private!, { headers: { authorization: `Bearer ${seeded.owner}` } })
  expect(png.headers.get("content-type")).toBe("image/png")
  expect([...new Uint8Array(await png.arrayBuffer()).subarray(1, 4)]).toEqual([0x50, 0x4e, 0x47])
  // Thumbnails, made by the Images binding (sharp, locally) on first fetch. A 192×128 image's
  // thumb_360 is its own size, and it's too small for thumb_480 and up.
  expect(file).toMatchObject({ thumb_360_w: 192, thumb_360_h: 128 })
  expect(file?.thumb_480).toBeUndefined()
  for (const [url, width, height] of [
    [file!.thumb_64!, 64, 64],
    [file!.thumb_360!, 192, 128],
  ] as const) {
    const thumb = await fetch(url, { headers: { authorization: `Bearer ${seeded.owner}` } })
    expect(thumb.headers.get("content-type")).toBe("image/png")
    const view = new DataView(await thumb.arrayBuffer())
    expect([view.getUint32(16), view.getUint32(20)]).toEqual([width, height])
  }
  const ims = await web.users.conversations({ types: "im,mpim" })
  expect(ims.channels).toHaveLength(2)
})
