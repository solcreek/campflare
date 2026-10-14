import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { expectError, fakeRequestUrls, ok, workspace } from "./helpers"

// Interactivity: clicks on an app's buttons reach the app as block_actions.

const URL = "https://app.example/interactive"
let urls: ReturnType<typeof fakeRequestUrls>

beforeEach(() => {
  urls = fakeRequestUrls()
})
afterEach(() => urls.restore())

type Settings = { app: { interactivity: { request_url: string | null } } }

describe("campflare.apps.setInteractivity", () => {
  it("sets and clears the Request URL, without a challenge", async () => {
    const w = await workspace()
    const app = await w.addApp("Clicky")
    const info = await ok<Settings>("campflare.apps.info", { app: app.id }, w.owner.token)
    expect(info.app.interactivity).toEqual({ request_url: null })
    const set = (request_url: string) =>
      ok<Settings>("campflare.apps.setInteractivity", { app: app.id, request_url }, w.owner.token)
    expect((await set(` ${URL} `)).app.interactivity).toEqual({ request_url: URL })
    expect((await set("http://localhost:3000/slack/events")).app.interactivity.request_url).toBe(
      "http://localhost:3000/slack/events",
    )
    expect((await set("")).app.interactivity).toEqual({ request_url: null })
    expect(urls.hits).toEqual([])
  })

  it("refuses a bad URL, a missing one, and someone else's app", async () => {
    const w = await workspace()
    const app = await w.addApp("Clicky")
    for (const request_url of ["http://app.example/x", "nope"]) {
      await expectError(
        "campflare.apps.setInteractivity",
        { app: app.id, request_url },
        w.owner.token,
        "invalid_arguments",
      )
    }
    await expectError("campflare.apps.setInteractivity", { app: app.id }, w.owner.token, "invalid_arguments")
    const bob = await w.addUser("bob")
    await expectError("campflare.apps.setInteractivity", { app: app.id, request_url: URL }, bob.token, "not_allowed")
  })
})
