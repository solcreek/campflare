import { describe, expect, it } from "vitest"
import { call, connect, expectError, ok, workspace } from "./helpers"

type User = { id: string; is_admin: boolean; is_owner: boolean; deleted: boolean }

const info = async (token: string, user: string) => (await ok<{ user: User }>("users.info", { user }, token)).user

describe("campflare.users.setRole", () => {
  it("lets an owner make people members, admins and owners", async () => {
    const w = await workspace()
    const bob = await w.addUser("bob")
    const made = await ok<{ user: User }>("campflare.users.setRole", { user: bob.id, role: "admin" }, w.owner.token)
    expect(made.user).toMatchObject({ is_admin: true, is_owner: false })
    await ok("campflare.users.setRole", { user: bob.id, role: "owner" }, w.owner.token)
    expect(await info(w.owner.token, bob.id)).toMatchObject({ is_admin: true, is_owner: true })
    await ok("campflare.users.setRole", { user: bob.id, role: "member" }, w.owner.token)
    expect(await info(w.owner.token, bob.id)).toMatchObject({ is_admin: false, is_owner: false })
  })

  it("is for owners only, and checks what it's given", async () => {
    const w = await workspace()
    const ada = await w.addUser("ada", { is_admin: true })
    const bob = await w.addUser("bob")
    const app = await w.addApp("Robô")
    await expectError("campflare.users.setRole", { user: bob.id, role: "admin" }, ada.token, "not_an_owner")
    await expectError("campflare.users.setRole", { user: bob.id, role: "admin" }, bob.token, "not_an_owner")
    await expectError("campflare.users.setRole", { user: bob.id, role: "king" }, w.owner.token, "invalid_arguments")
    await expectError("campflare.users.setRole", { user: "UNOPE", role: "admin" }, w.owner.token, "user_not_found")
    await expectError("campflare.users.setRole", { user: app.botUserId, role: "admin" }, w.owner.token, "user_is_bot")
  })

  it("never leaves the workspace without an owner", async () => {
    const w = await workspace()
    await expectError("campflare.users.setRole", { user: w.owner.id, role: "admin" }, w.owner.token, "last_owner")
    const bob = await w.addUser("bob")
    await ok("campflare.users.setRole", { user: bob.id, role: "owner" }, w.owner.token)
    // With a second owner, the first may step down, and then has no say over roles.
    await ok("campflare.users.setRole", { user: w.owner.id, role: "member" }, w.owner.token)
    await expectError("campflare.users.setRole", { user: bob.id, role: "member" }, w.owner.token, "not_an_owner")
    await expectError("campflare.users.setRole", { user: bob.id, role: "member" }, bob.token, "last_owner")
  })

  it("takes effect at once on every token the person holds", async () => {
    const w = await workspace()
    const ada = await w.addUser("ada", { is_admin: true })
    const second = (await ok<{ token: string }>("campflare.tokens.create", { label: "script" }, ada.token)).token
    await ok("campflare.users.create", { name: "carol" }, second)
    await ok("campflare.users.setRole", { user: ada.id, role: "member" }, w.owner.token)
    await expectError("campflare.users.create", { name: "dmitri" }, second, "not_an_admin")
  })

  it("tells everyone, as user_change", async () => {
    const w = await workspace()
    const bob = await w.addUser("bob")
    const rtm = await ok<{ url: string }>("rtm.connect", {}, bob.token)
    const link = await connect(rtm.url)
    await link.next((f) => f.type === "hello")
    await ok("campflare.users.setRole", { user: bob.id, role: "admin" }, w.owner.token)
    const change = await link.next((f) => f.type === "user_change")
    expect(change).toMatchObject({ user: { id: bob.id, is_admin: true } })
    link.ws.close()
  })
})

describe("acting on someone takes a role above theirs", () => {
  it("lets admins deactivate members, and only owners deactivate admins; owners can't be", async () => {
    const w = await workspace()
    const ada = await w.addUser("ada", { is_admin: true })
    const eve = await w.addUser("eve", { is_admin: true })
    const bob = await w.addUser("bob")
    await expectError("campflare.users.deactivate", { user: eve.id }, ada.token, "not_an_owner")
    await expectError("campflare.users.deactivate", { user: w.owner.id }, ada.token, "cant_act_on_owner")
    await ok("campflare.users.deactivate", { user: bob.id }, ada.token)
    await ok("campflare.users.deactivate", { user: eve.id }, w.owner.token)
    const second = await w.addUser("zoe")
    await ok("campflare.users.setRole", { user: second.id, role: "owner" }, w.owner.token)
    await expectError("campflare.users.deactivate", { user: second.id }, w.owner.token, "cant_act_on_owner")
  })

  it("mints a token for someone else only below your own role", async () => {
    const w = await workspace()
    const ada = await w.addUser("ada", { is_admin: true })
    const eve = await w.addUser("eve", { is_admin: true })
    const bob = await w.addUser("bob")
    await ok("campflare.tokens.create", { user: bob.id }, ada.token)
    await expectError("campflare.tokens.create", { user: eve.id }, ada.token, "not_an_owner")
    await expectError("campflare.tokens.create", { user: w.owner.id }, ada.token, "cant_act_on_owner")
    await ok("campflare.tokens.create", { user: eve.id }, w.owner.token)
  })

  it("lets only owners add an admin", async () => {
    const w = await workspace()
    const ada = await w.addUser("ada", { is_admin: true })
    await expectError("campflare.users.create", { name: "felix", is_admin: true }, ada.token, "not_an_owner")
    await ok("campflare.users.create", { name: "felix" }, ada.token)
  })

  it("deactivates an app's bot user too", async () => {
    const w = await workspace()
    const app = await w.addApp("Viejo")
    await ok("campflare.users.deactivate", { user: app.botUserId }, w.owner.token)
    expect((await call("auth.test", {}, app.botToken)).ok).toBe(false)
  })
})
