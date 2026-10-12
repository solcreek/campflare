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
  const history = await web.conversations.history({ channel: seeded.channels.dev! })
  expect(history.messages?.map((m) => m.text)).toContain("部署失敗的原因找到了，是 migration 重複執行")
  const ims = await web.users.conversations({ types: "im,mpim" })
  expect(ims.channels).toHaveLength(2)
})
