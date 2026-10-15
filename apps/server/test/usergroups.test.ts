import { env } from "cloudflare:workers"
import { describe, expect, it } from "vitest"
import { groupMembers, subteamMentions } from "../src/db/usergroups"
import { connect, expectError, ok, workspace } from "./helpers"

type Group = {
  id: string
  team_id: string
  handle: string
  name: string
  description: string
  users?: string[]
  user_count: number
  date_create: number
  date_update: number
  date_delete: number
  created_by: string
  updated_by: string
  deleted_by: string | null
  prefs: { channels: string[]; groups: string[] }
}

async function live(token: string) {
  const rtm = await ok<{ url: string }>("rtm.connect", {}, token)
  const link = await connect(rtm.url)
  await link.next((f) => f.type === "hello")
  return link
}

describe("usergroups", () => {
  it("creates a group in Slack's shape, and tells everyone", async () => {
    const w = await workspace()
    const bob = await w.addUser("bob")
    const link = await live(bob.token)
    const made = await ok<{ usergroup: Group }>(
      "usergroups.create",
      { name: "Diseño · デザイン", handle: "@Design", description: "Équipe 디자인", channels: w.general },
      w.owner.token,
    )
    expect(made.usergroup).toMatchObject({
      team_id: w.teamId,
      is_usergroup: true,
      is_subteam: true,
      handle: "design",
      name: "Diseño · デザイン",
      description: "Équipe 디자인",
      users: [],
      user_count: 0,
      date_delete: 0,
      created_by: w.owner.id,
      updated_by: w.owner.id,
      deleted_by: null,
      prefs: { channels: [w.general], groups: [] },
    })
    expect(made.usergroup.id).toMatch(/^S[0-9A-Z]{10}$/)
    const event = await link.next((f) => f.type === "subteam_created")
    expect(event).toMatchObject({ subteam: { id: made.usergroup.id, handle: "design" } })
    link.close()
  })

  it("derives a handle from the name, and refuses clashes with groups and people", async () => {
    const w = await workspace()
    await w.addUser("bob")
    const derived = await ok<{ usergroup: Group }>("usergroups.create", { name: "Équipe Front-end" }, w.owner.token)
    expect(derived.usergroup.handle).toBe("equipe-front-end")
    const trimmed = await ok<{ usergroup: Group }>("usergroups.create", { name: "_Ops (Café)." }, w.owner.token)
    expect(trimmed.usergroup.handle).toBe("ops-cafe")
    // Cut at 80 characters where a separator falls: the separator goes too.
    const long = await ok<{ usergroup: Group }>("usergroups.create", { name: `${"a".repeat(79)} tail` }, w.owner.token)
    expect(long.usergroup.handle).toBe("a".repeat(79))
    await expectError("usergroups.create", { name: "日本語チーム" }, w.owner.token, "invalid_arguments")
    await expectError(
      "usergroups.create",
      { name: "Other", handle: "equipe-front-end" },
      w.owner.token,
      "handle_already_exists",
    )
    await expectError(
      "usergroups.create",
      { name: "ÉQUIPE FRONT-END", handle: "x" },
      w.owner.token,
      "name_already_exists",
    )
    // A person's name is a handle too.
    await expectError("usergroups.create", { name: "Bobs", handle: "bob" }, w.owner.token, "handle_already_exists")
    await expectError("campflare.users.create", { name: "equipe-front-end" }, w.owner.token, "name_taken")
    // A bot user isn't refused for a group's handle: built-in bots' handles are fixed.
    await ok("usergroups.create", { name: "Robots", handle: "robot" }, w.owner.token)
    await w.addApp("Robot")
    await expectError("usergroups.create", { name: "All", handle: "here" }, w.owner.token, "invalid_handle")
    await expectError("usergroups.create", { name: "Bad", handle: "no spaces" }, w.owner.token, "invalid_handle")
    await expectError("usergroups.create", { name: "  " }, w.owner.token, "invalid_name")
    await expectError(
      "usergroups.create",
      { name: "Chan", handle: "chan", channels: "CNOPE" },
      w.owner.token,
      "invalid_channel",
    )
  })

  it("updates a group's name, handle, description and channels", async () => {
    const w = await workspace()
    const bob = await w.addUser("bob")
    const { usergroup } = await ok<{ usergroup: Group }>(
      "usergroups.create",
      { name: "Ops", handle: "ops" },
      w.owner.token,
    )
    const link = await live(w.owner.token)
    const updated = await ok<{ usergroup: Group }>(
      "usergroups.update",
      { usergroup: usergroup.id, name: "Opérations", handle: "oncall", description: "운영", channels: "" },
      bob.token,
    )
    expect(updated.usergroup).toMatchObject({
      name: "Opérations",
      handle: "oncall",
      description: "운영",
      updated_by: bob.id,
      created_by: w.owner.id,
      prefs: { channels: [] },
    })
    expect(await link.next((f) => f.type === "subteam_updated")).toMatchObject({ subteam: { handle: "oncall" } })
    link.close()
    // Nothing to change: answered as it is.
    expect(
      (await ok<{ usergroup: Group }>("usergroups.update", { usergroup: usergroup.id }, bob.token)).usergroup,
    ).toMatchObject({ handle: "oncall" })
    await expectError("usergroups.update", { usergroup: "SNOPE", name: "x" }, bob.token, "no_such_subteam")
    await expectError("usergroups.update", { usergroup: "SNOPE" }, bob.token, "no_such_subteam")
    await ok("usergroups.create", { name: "Other", handle: "other" }, w.owner.token)
    await expectError(
      "usergroups.update",
      { usergroup: usergroup.id, handle: "other" },
      bob.token,
      "handle_already_exists",
    )
    await expectError(
      "usergroups.update",
      { usergroup: usergroup.id, handle: "bob" },
      bob.token,
      "handle_already_exists",
    )
    await expectError("usergroups.update", { usergroup: usergroup.id, name: "OTHER" }, bob.token, "name_already_exists")
  })

  it("replaces members, with Slack's events to everyone and to those added and removed", async () => {
    const w = await workspace()
    const ana = await w.addUser("ana")
    const bob = await w.addUser("bob")
    const chloe = await w.addUser("chloe")
    const { usergroup: g } = await ok<{ usergroup: Group }>(
      "usergroups.create",
      { name: "Front", handle: "front" },
      w.owner.token,
    )
    const first = await ok<{ usergroup: Group }>(
      "usergroups.users.update",
      { usergroup: g.id, users: `${ana.id},${bob.id}` },
      w.owner.token,
    )
    expect(first.usergroup.users).toEqual([ana.id, bob.id].toSorted())
    expect(first.usergroup.user_count).toBe(2)

    const anaLink = await live(ana.token)
    const chloeLink = await live(chloe.token)
    const ownerLink = await live(w.owner.token)
    await ok("usergroups.users.update", { usergroup: g.id, users: `${bob.id},${chloe.id}` }, w.owner.token)
    const changed = await ownerLink.next((f) => f.type === "subteam_members_changed")
    expect(changed).toMatchObject({
      subteam_id: g.id,
      team_id: w.teamId,
      date_previous_update: first.usergroup.date_update,
      added_users: [chloe.id],
      added_users_count: "1",
      removed_users: [ana.id],
      removed_users_count: "1",
    })
    expect(await ownerLink.next((f) => f.type === "subteam_updated")).toMatchObject({ subteam: { user_count: 2 } })
    expect(await chloeLink.next((f) => f.type === "subteam_self_added")).toMatchObject({
      type: "subteam_self_added",
      subteam_id: g.id,
    })
    expect(await anaLink.next((f) => f.type === "subteam_self_removed")).toMatchObject({ subteam_id: g.id })
    for (const link of [anaLink, chloeLink, ownerLink]) link.close()

    expect(await ok("usergroups.users.list", { usergroup: g.id }, ana.token)).toMatchObject({
      users: [bob.id, chloe.id].toSorted(),
    })
    // The same list again changes nothing.
    await ok("usergroups.users.update", { usergroup: g.id, users: `${chloe.id},${bob.id}` }, w.owner.token)
    // Never emptied, as on Slack: disable it instead.
    await expectError("usergroups.users.update", { usergroup: g.id, users: "" }, w.owner.token, "no_users_provided")
    await expectError("usergroups.users.update", { usergroup: g.id }, w.owner.token, "no_users_provided")

    // A deactivated member is no member: replacing the list never reports them removed.
    await ok("campflare.users.deactivate", { user: chloe.id }, w.owner.token)
    const watch = await live(w.owner.token)
    await ok("usergroups.users.update", { usergroup: g.id, users: `${bob.id},${ana.id}` }, w.owner.token)
    expect(await watch.next((f) => f.type === "subteam_members_changed")).toMatchObject({
      added_users: [ana.id],
      removed_users: [],
      removed_users_count: "0",
    })
    watch.close()
    expect(await ok("usergroups.users.list", { usergroup: g.id }, ana.token)).toMatchObject({
      users: [ana.id, bob.id].toSorted(),
    })

    const app = await w.addApp("Groupbot")
    await expectError(
      "usergroups.users.update",
      { usergroup: g.id, users: app.botUserId },
      w.owner.token,
      "invalid_users",
    )
    await expectError("usergroups.users.update", { usergroup: g.id, users: "UNOPE" }, w.owner.token, "invalid_users")
    await expectError(
      "usergroups.users.update",
      { usergroup: "SNOPE", users: ana.id },
      w.owner.token,
      "no_such_subteam",
    )
  })

  it("disables and enables; disabled groups leave the list unless asked for", async () => {
    const w = await workspace()
    const bob = await w.addUser("bob")
    const { usergroup: a } = await ok<{ usergroup: Group }>(
      "usergroups.create",
      { name: "Alpha", handle: "alpha" },
      w.owner.token,
    )
    const { usergroup: b } = await ok<{ usergroup: Group }>(
      "usergroups.create",
      { name: "beta", handle: "beta" },
      w.owner.token,
    )
    await ok("usergroups.users.update", { usergroup: a.id, users: bob.id }, w.owner.token)

    const link = await live(w.owner.token)
    const off = await ok<{ usergroup: Group }>("usergroups.disable", { usergroup: b.id }, bob.token)
    expect(off.usergroup.date_delete).toBeGreaterThan(0)
    expect(off.usergroup.deleted_by).toBe(bob.id)
    expect(await link.next((f) => f.type === "subteam_updated")).toMatchObject({ subteam: { id: b.id } })
    link.close()
    // Again: as it is.
    expect(
      (await ok<{ usergroup: Group }>("usergroups.disable", { usergroup: b.id }, bob.token)).usergroup.date_delete,
    ).toBe(off.usergroup.date_delete)

    const plain = await ok<{ usergroups: Group[] }>("usergroups.list", {}, bob.token)
    expect(plain.usergroups.map((g) => g.handle)).toEqual(["alpha"])
    expect(plain.usergroups[0]!.users).toBeUndefined()
    expect(plain.usergroups[0]!.user_count).toBe(1)
    const full = await ok<{ usergroups: Group[] }>(
      "usergroups.list",
      { include_disabled: true, include_users: true, include_count: true },
      bob.token,
    )
    expect(full.usergroups.map((g) => [g.handle, g.users])).toEqual([
      ["alpha", [bob.id]],
      ["beta", []],
    ])

    await expectError("usergroups.users.list", { usergroup: b.id }, bob.token, "no_such_subteam")
    expect(await ok("usergroups.users.list", { usergroup: b.id, include_disabled: true }, bob.token)).toMatchObject({
      users: [],
    })
    // Its handle stays taken.
    await expectError("usergroups.create", { name: "Beta 2", handle: "beta" }, bob.token, "handle_already_exists")

    const on = await ok<{ usergroup: Group }>("usergroups.enable", { usergroup: b.id }, bob.token)
    expect(on.usergroup).toMatchObject({ date_delete: 0, deleted_by: null })
    await ok("usergroups.enable", { usergroup: b.id }, bob.token)
    await expectError("usergroups.enable", { usergroup: "SNOPE" }, bob.token, "no_such_subteam")
  })

  it("wants usergroups:read to read and usergroups:write to change; bots read by default", async () => {
    const w = await workspace()
    const reader = (await ok<{ token: string }>("campflare.tokens.create", { preset: "read" }, w.owner.token)).token
    const writer = (await ok<{ token: string }>("campflare.tokens.create", { preset: "write" }, w.owner.token)).token
    await ok("usergroups.list", {}, reader)
    await expectError("usergroups.create", { name: "Nope", handle: "nope" }, writer, "missing_scope")
    const app = await w.addApp("Readbot")
    await ok("usergroups.list", {}, app.botToken)
    await expectError("usergroups.create", { name: "Nope", handle: "nope" }, app.botToken, "missing_scope")
  })

  it("reaches a group's members for a mention: enabled groups, active people, each once", async () => {
    const w = await workspace()
    const ana = await w.addUser("ana")
    const bob = await w.addUser("bob")
    const gone = await w.addUser("gone")
    const make = async (handle: string, users: string[]) => {
      const { usergroup } = await ok<{ usergroup: Group }>("usergroups.create", { name: handle, handle }, w.owner.token)
      await ok("usergroups.users.update", { usergroup: usergroup.id, users: users.join(",") }, w.owner.token)
      return usergroup.id
    }
    const one = await make("one", [ana.id, bob.id, gone.id])
    const two = await make("two", [bob.id])
    const off = await make("off", [w.owner.id])
    await ok("usergroups.disable", { usergroup: off }, w.owner.token)
    await ok("campflare.users.deactivate", { user: gone.id }, w.owner.token)

    const text = `hi <!subteam^${one}|@one> and <!subteam^${two}> <!subteam^${one}> <!subteam^${off}|@off>`
    expect(subteamMentions(text)).toEqual([one, two, off])
    expect((await groupMembers(env, w.teamId, subteamMentions(text))).toSorted()).toEqual([ana.id, bob.id].toSorted())
    expect(await groupMembers(env, "TOTHER", [one])).toEqual([])
    expect(await groupMembers(env, w.teamId, [])).toEqual([])
  })
})
