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
  const ims = await web.users.conversations({ types: "im,mpim" })
  expect(ims.channels).toHaveLength(2)
})
