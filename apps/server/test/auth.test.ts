import { SELF } from "cloudflare:test"
import { describe, expect, it } from "vitest"
import { call, expectError, ok, workspace } from "./helpers"

describe("api.test", () => {
  it("echoes its arguments without a token", async () => {
    expect(await call("api.test", { foo: "bar" })).toEqual({ ok: true, args: { foo: "bar" } })
    expect(await call("api.test")).toEqual({ ok: true })
  })

  it("returns the error it is asked for", async () => {
    expect(await call("api.test", { error: "my_error" })).toMatchObject({ ok: false, error: "my_error" })
  })
})

describe("authentication", () => {
  it("rejects a missing or unknown token", async () => {
    await expectError("auth.test", {}, undefined, "not_authed")
    await expectError("auth.test", {}, "xoxp-T123-deadbeef", "invalid_auth")
    await expectError("auth.test", {}, "bogus", "invalid_auth")
  })

  it("accepts the token as an argument as well as a header", async () => {
    const w = await workspace()
    const body = await call("auth.test", { token: w.owner.token })
    expect(body).toMatchObject({ ok: true, user_id: w.owner.id, team_id: w.teamId, user: "owner" })
  })

  it("answers unknown methods as Slack does", async () => {
    expect(await call("nope.nothing")).toMatchObject({ ok: false, error: "unknown_method" })
  })

  it("checks the token kind each method takes", async () => {
    const w = await workspace()
    const app = await w.addApp("Robot")
    await expectError("auth.test", {}, app.appToken, "not_allowed_token_type")
    await expectError("apps.connections.open", {}, w.owner.token, "not_allowed_token_type")
    await expectError("search.messages", { query: "x" }, app.botToken, "not_allowed_token_type")
  })

  it("auth.test names the bot for a bot token", async () => {
    const w = await workspace()
    const app = await w.addApp("Robot")
    expect(await ok("auth.test", {}, app.botToken)).toMatchObject({
      user_id: app.botUserId,
      bot_id: app.botId,
      app_id: app.id,
    })
  })

  it("auth.revoke ends a token", async () => {
    const w = await workspace()
    const { token } = await ok<{ token: string }>("campflare.tokens.create", { label: "laptop" }, w.owner.token)
    expect(await ok("auth.revoke", { test: true }, token)).toMatchObject({ revoked: false })
    expect(await ok("auth.revoke", {}, token)).toMatchObject({ revoked: true })
    await expectError("auth.test", {}, token, "token_revoked")
  })

  it("parses JSON bodies and GET query strings", async () => {
    const w = await workspace()
    expect(await ok("auth.test", {}, w.owner.token, { json: true })).toMatchObject({ user_id: w.owner.id })
    expect(await ok("auth.test", {}, w.owner.token, { get: true })).toMatchObject({ user_id: w.owner.id })
  })

  it("rejects malformed JSON", async () => {
    const res = await SELF.fetch(
      new Request("https://campflare.test/api/auth.test", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{nope",
      }),
    )
    expect(await res.json()).toMatchObject({ ok: false, error: "invalid_json" })
  })
})

describe("team and misc", () => {
  it("team.info, emoji.list, bots.info", async () => {
    const w = await workspace("Acme Corp")
    const app = await w.addApp("Robot")
    expect(await ok("team.info", {}, w.owner.token)).toMatchObject({
      team: { id: w.teamId, name: "Acme Corp", domain: "acme-corp" },
    })
    expect(await ok("emoji.list", {}, w.owner.token)).toMatchObject({ emoji: {} })
    expect(await ok("bots.info", { bot: app.botId }, w.owner.token)).toMatchObject({
      bot: { id: app.botId, app_id: app.id, user_id: app.botUserId, name: "Robot" },
    })
    await expectError("bots.info", { bot: "BNOPE" }, w.owner.token, "bot_not_found")
    expect(await ok<{ apps: unknown[] }>("apps.list", {}, w.owner.token)).toMatchObject({ apps: [{ id: app.id }] })
  })
})
