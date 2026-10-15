import { describe, expect, it } from "vitest"
import { baseUrl, loggedIn, memoryIo } from "./harness"

const uniqueEmail = (name: string) => `${name}-${crypto.randomUUID().slice(0, 8)}@example.test`

const signIn = (email: string, password: string) =>
  fetch(`${baseUrl}/auth/sign-in/campflare-password`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: baseUrl },
    body: JSON.stringify({ email, password }),
  })

describe("invitations", () => {
  it("makes a link, joins through it from the terminal, lists and revokes", async () => {
    const admin = await loggedIn()
    expect(await admin.run("create-channel", "dev")).toBe(0)
    admin.clear()
    expect(await admin.run("admin", "invite", "--channel", "#dev", "--uses", "2", "--expires", "2d")).toBe(0)
    const url = admin.out.trim()
    expect(url).toMatch(/\/join\/[0-9a-f]{64}$/)
    expect(admin.err).toMatch(/^I[A-Z0-9]+ {2}pending {2}open link, 0\/2 used {2}member, \+ 1 channel {2}expires /)

    const email = uniqueEmail("sofia")
    const person = memoryIo({ secrets: ["Sofía en Bogotá", "Sofía en Bogotá"] })
    expect(await person.run("join", url, "sofia", "--name", "Sofía Núñez", "--email", email)).toBe(0)
    expect(person.out).toMatch(/^Joined .+ as @sofia \(profile default\)/)
    expect(person.config?.profiles.default).toMatchObject({ url: baseUrl, via: "oauth" })
    person.clear()
    expect(await person.run("channels")).toBe(0)
    expect(person.out).toContain("#dev")
    expect((await signIn(email, "Sofía en Bogotá")).status).toBe(200)

    const piped = memoryIo({ stdin: "지민의 비밀번호입니다\n" })
    expect(await piped.run("join", url, "jimin", "--email", uniqueEmail("jimin"), "--json", "--profile", "j")).toBe(0)
    expect(JSON.parse(piped.out)).toMatchObject({ user: { name: "jimin" }, profile: "j" })

    const late = memoryIo({ stdin: "long enough password\n" })
    expect(await late.run("join", url, "late", "--email", uniqueEmail("late"))).toBe(1)
    expect(late.err).toContain("invite_used_up")

    admin.clear()
    expect(await admin.run("admin", "invites")).toBe(0)
    expect(admin.out).toContain("used_up  open link, 2/2 used")
    expect(admin.out).toContain("by @owner")
    admin.clear()
    expect(await admin.run("admin", "invite", "--email", uniqueEmail("hugo"), "--admin", "--json")).toBe(0)
    const bound = JSON.parse(admin.out) as { url: string; invite: { id: string; role: string } }
    expect(bound.invite.role).toBe("admin")
    admin.clear()
    expect(await admin.run("admin", "invite", "revoke", bound.invite.id)).toBe(0)
    expect(admin.out).toBe(`Revoked invite ${bound.invite.id}\n`)
    admin.clear()
    expect(await admin.run("admin", "invites", "--json")).toBe(0)
    expect(JSON.parse(admin.out)).toContainEqual(expect.objectContaining({ id: bound.invite.id, state: "revoked" }))
    expect(await admin.run("admin", "invite", "revoke", bound.invite.id, "--json")).toBe(0)
  })

  it("says what's missing", async () => {
    const admin = await loggedIn()
    expect(await admin.run("admin", "invite", "revoke")).toBe(2)
    expect(await admin.run("admin", "invite", "extra")).toBe(2)
    expect(await admin.run("admin", "bogus")).toBe(2)
    expect(admin.err).toContain("invite, invites, reset-password")
    expect(await admin.run("admin", "reset-password")).toBe(2)
    expect(await memoryIo().run("join", `${baseUrl}/join/abc`)).toBe(2)
    expect(await memoryIo().run("join", `${baseUrl}/join/abc`, "nobody")).toBe(2) // no stdin, no terminal
    const mistyped = memoryIo({ secrets: ["Première phrase", "Zweiter Satz!"] })
    expect(await mistyped.run("join", `${baseUrl}/join/abc`, "x")).toBe(2)
    expect(mistyped.err).toContain("differ")
    expect(await memoryIo().run("join")).toBe(2)
  })
})

describe("password resets", () => {
  it("makes a link for someone, and sets a new password through it", async () => {
    const admin = await loggedIn()
    const email = uniqueEmail("chen")
    expect(await admin.run("admin", "add-user", "chen", "--email", email)).toBe(0)
    admin.clear()
    expect(await admin.run("admin", "reset-password", "@chen", "--expires", "30m")).toBe(0)
    const url = admin.out.trim()
    expect(url).toMatch(/\/reset\/[0-9a-f]{64}$/)
    expect(admin.err).toContain("Single use")

    const person = memoryIo({ secrets: ["陳先生的新密碼很長啊", "陳先生的新密碼很長啊"] })
    expect(await person.run("password", "reset", url)).toBe(0)
    expect(person.out).toContain("Password changed")
    expect((await signIn(email, "陳先生的新密碼很長啊")).status).toBe(200)

    const again = memoryIo({ stdin: "another long password\n" })
    expect(await again.run("password", "reset", url, "--json")).toBe(1)
    expect(again.err).toContain("invalid_reset")

    admin.clear()
    expect(await admin.run("admin", "reset-password", "@chen", "--json")).toBe(0)
    const fresh = JSON.parse(admin.out) as { url: string }
    const json = memoryIo({ stdin: "naïve café password\n" })
    expect(await json.run("password", "reset", fresh.url, "--json")).toBe(0)
    expect(JSON.parse(json.out)).toMatchObject({ ok: true })
    expect(await memoryIo().run("password", "reset", "not a link")).toBe(2)
  })
})
