import { describe, expect, it } from "vitest"
import { call, expectError, ok, workspace } from "./helpers"

describe("campflare.bootstrap", () => {
  it("needs the secret and a free domain", async () => {
    await expectError(
      "campflare.bootstrap",
      { secret: "wrong", team_name: "x", user_name: "a" },
      undefined,
      "not_allowed",
    )
    await ok("campflare.bootstrap", { secret: "test-bootstrap", team_name: "Dupe", user_name: "a" })
    await expectError(
      "campflare.bootstrap",
      { secret: "test-bootstrap", team_name: "dupe", user_name: "a" },
      undefined,
      "domain_taken",
    )
    await expectError(
      "campflare.bootstrap",
      { secret: "test-bootstrap", team_name: "!!!", user_name: "a" },
      undefined,
      "invalid_arguments",
    )
    const missing = await call("campflare.bootstrap", { secret: "test-bootstrap", user_name: "a" })
    expect(missing).toMatchObject({
      ok: false,
      error: "invalid_arguments",
      response_metadata: { messages: ["[ERROR] missing required field: team_name"] },
    })
  })
})

describe("people and tokens", () => {
  it("only admins add people; handles and emails are unique", async () => {
    const w = await workspace()
    const bob = await w.addUser("bob")
    await expectError("campflare.users.create", { name: "carol" }, bob.token, "not_allowed_token_type")
    await expectError("campflare.users.create", { name: "bob" }, w.owner.token, "name_taken")
    await ok("campflare.users.create", { name: "dee", email: "dee@x.test" }, w.owner.token)
    await expectError("campflare.users.create", { name: "dee2", email: "DEE@x.test" }, w.owner.token, "already_in_team")
    await expectError("campflare.users.create", { name: "Bad Handle" }, w.owner.token, "invalid_name")
    const admin = await w.addUser("ada", { is_admin: true })
    await ok("campflare.users.create", { name: "carol" }, admin.token)
    // New people land in #general.
    const members = await ok<{ members: string[] }>("conversations.members", { channel: w.general }, w.owner.token)
    expect(members.members).toContain(bob.id)
  })

  it("deactivating someone revokes their tokens", async () => {
    const w = await workspace()
    const bob = await w.addUser("bob")
    await expectError("campflare.users.deactivate", { user: bob.id }, bob.token, "not_allowed_token_type")
    await expectError("campflare.users.deactivate", { user: w.owner.id }, w.owner.token, "cant_deactivate_self")
    await ok("campflare.users.deactivate", { user: bob.id }, w.owner.token)
    await expectError("campflare.users.deactivate", { user: bob.id }, w.owner.token, "user_not_found")
    const res = await call("auth.test", {}, bob.token)
    expect(["account_inactive", "token_revoked"]).toContain(res.error)
    expect(await ok("users.info", { user: bob.id }, w.owner.token)).toMatchObject({ user: { deleted: true } })
  })

  it("creates, lists and revokes your own tokens", async () => {
    const w = await workspace()
    const bob = await w.addUser("bob")
    const created = await ok<{ token: string }>("campflare.tokens.create", { label: "cli" }, bob.token)
    expect(created.token).toMatch(/^xoxp-/)
    await expectError("campflare.tokens.create", { user: w.owner.id }, bob.token, "not_allowed_token_type")
    await ok("campflare.tokens.create", { user: bob.id }, w.owner.token)
    await expectError("campflare.tokens.create", { user: "UNOPE" }, w.owner.token, "user_not_found")
    const list = await ok<{ tokens: { id: string; label: string }[] }>("campflare.tokens.list", {}, bob.token)
    expect(list.tokens.map((t) => t.label)).toContain("cli")
    const cli = list.tokens.find((t) => t.label === "cli")!
    expect(await ok("campflare.tokens.revoke", { id: cli.id }, bob.token)).toMatchObject({ revoked: true })
    await expectError("auth.test", {}, created.token, "token_revoked")
    await expectError("campflare.tokens.revoke", { id: "zz" }, bob.token, "invalid_arguments")
  })
})
