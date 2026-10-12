import { describe, expect, it } from "vitest"
import { expectError, ok, workspace } from "./helpers"

type User = {
  id: string
  name: string
  real_name: string
  is_admin: boolean
  is_bot: boolean
  deleted: boolean
  profile: Record<string, unknown>
}

describe("users", () => {
  it("users.info, users.list (paged) and users.lookupByEmail", async () => {
    const w = await workspace("Users Co")
    const bob = await w.addUser("bob")
    await w.addApp("Robot")
    const info = await ok<{ user: User }>("users.info", { user: bob.id }, w.owner.token)
    expect(info.user).toMatchObject({
      id: bob.id,
      name: "bob",
      real_name: "BOB",
      is_bot: false,
      profile: { email: "bob@Users Co.test".toLowerCase() },
    })
    await expectError("users.info", { user: "UNOPE" }, w.owner.token, "user_not_found")
    await expectError("users.info", {}, w.owner.token, "user_not_found")

    const all: User[] = []
    let cursor: string | undefined
    do {
      const page = await ok<{ members: User[]; response_metadata: { next_cursor: string } }>(
        "users.list",
        { limit: 2, cursor },
        w.owner.token,
      )
      all.push(...page.members)
      cursor = page.response_metadata.next_cursor || undefined
    } while (cursor)
    expect(all.map((u) => u.name).toSorted()).toEqual(["bob", "owner", "robot"])
    expect(all.find((u) => u.name === "robot")).toMatchObject({ is_bot: true })

    const found = await ok<{ user: User }>("users.lookupByEmail", { email: "BOB@users co.test" }, w.owner.token)
    expect(found.user.id).toBe(bob.id)
    await expectError("users.lookupByEmail", { email: "nobody@x" }, w.owner.token, "users_not_found")
  })

  it("profile get and set", async () => {
    const w = await workspace()
    const set = await ok<{ profile: Record<string, unknown> }>(
      "users.profile.set",
      { profile: { display_name: "Liv", status_text: "Shipping", status_emoji: ":ship:", ignored: "x" } },
      w.owner.token,
    )
    expect(set.profile).toMatchObject({ display_name: "Liv", status_text: "Shipping", status_emoji: ":ship:" })
    await ok("users.profile.set", { name: "title", value: "CEO" }, w.owner.token)
    expect(await ok("users.profile.get", {}, w.owner.token)).toMatchObject({
      profile: { title: "CEO", display_name: "Liv" },
    })
    await expectError("users.profile.set", { profile: { nope: 1 } }, w.owner.token, "invalid_profile")
  })

  it("presence follows activity and users.setPresence", async () => {
    const w = await workspace()
    const bob = await w.addUser("bob")
    // Bob hasn't used his token yet.
    expect(await ok("users.getPresence", { user: bob.id }, w.owner.token)).toMatchObject({ presence: "away" })
    await ok("auth.test", {}, bob.token)
    // touch() lands after the response; poll briefly.
    let presence = ""
    for (let i = 0; i < 20 && presence !== "active"; i++) {
      presence = (await ok<{ presence: string }>("users.getPresence", { user: bob.id }, w.owner.token)).presence
      if (presence !== "active") await new Promise((r) => setTimeout(r, 25))
    }
    expect(presence).toBe("active")
    await ok("users.setPresence", { presence: "away" }, bob.token)
    expect(await ok("users.getPresence", {}, bob.token)).toMatchObject({ presence: "away", manual_away: true })
    await expectError("users.setPresence", { presence: "busy" }, bob.token, "invalid_presence")
    const app = await w.addApp("Robot")
    expect(await ok("users.getPresence", { user: app.botUserId }, w.owner.token)).toMatchObject({ presence: "active" })
  })
})

describe("dnd", () => {
  it("snoozes and ends the snooze", async () => {
    const w = await workspace()
    expect(await ok("dnd.info", {}, w.owner.token)).toMatchObject({ dnd_enabled: false, snooze_enabled: false })
    const snoozed = await ok<{ snooze_enabled: boolean; snooze_remaining: number }>(
      "dnd.setSnooze",
      { num_minutes: 30 },
      w.owner.token,
    )
    expect(snoozed.snooze_enabled).toBe(true)
    expect(snoozed.snooze_remaining).toBeGreaterThan(29 * 60)
    expect(await ok("dnd.info", { user: w.owner.id }, w.owner.token)).toMatchObject({ snooze_enabled: true })
    const team = await ok<{ users: Record<string, { snooze_enabled: boolean }> }>("dnd.teamInfo", {}, w.owner.token)
    expect(team.users[w.owner.id]!.snooze_enabled).toBe(true)
    expect(await ok("dnd.endSnooze", {}, w.owner.token)).toMatchObject({ snooze_enabled: false })
    await expectError("dnd.endSnooze", {}, w.owner.token, "snooze_not_active")
    await expectError("dnd.setSnooze", {}, w.owner.token, "invalid_num_minutes")
    await expectError("dnd.info", { user: "UNOPE" }, w.owner.token, "user_not_found")
    await ok("dnd.endDnd", {}, w.owner.token)
  })
})
