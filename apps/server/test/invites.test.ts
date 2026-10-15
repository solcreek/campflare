import { SELF } from "cloudflare:test"
import { env } from "cloudflare:workers"
import { afterEach, describe, expect, it } from "vitest"
import { setEmailSender, type EmailMessage } from "../src/email"
import { joinedPage } from "../src/auth/links"
import { isEmail, normalizeEmail } from "../src/api/email-address"
import { IP_FREE_FAILURES, RATE_LIMIT } from "../src/auth/throttle"
import { browser } from "./browser"
import { call, connect, eventually, expectError, ok, ORIGIN, workspace, type Body } from "./helpers"

let n = 0
/** A client address no other request uses, so throttling is each test's own. */
const freshIp = () => `2001:db8:1::${(++n).toString(16)}`
const uniqueEmail = (name: string) => `${name}-${++n}-${Date.now()}@example.test`

/** A no-token method with a client address, as Cloudflare sets it. */
async function anonymous<T = Body>(method: string, args: Record<string, unknown>, ip = freshIp()) {
  const res = await SELF.fetch(`${ORIGIN}/api/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json", "cf-connecting-ip": ip },
    body: JSON.stringify(args),
  })
  return (await res.json()) as T & Body
}

const signIn = (email: string, password: string) =>
  SELF.fetch(`${ORIGIN}/auth/sign-in/campflare-password`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: ORIGIN, "cf-connecting-ip": freshIp() },
    body: JSON.stringify({ email, password }),
  })

type Invite = { id: string; state: string; uses: number; max_uses: number; role: string; email: string | null }
type Created = { invite: Invite; url: string; emailed: boolean }
type Joined = { user: { id: string; name: string; is_admin: boolean; profile: { email: string } }; token: string }

const codeOf = (url: string) => url.split("/join/")[1]!

async function invite(token: string, args: Record<string, unknown> = {}) {
  return ok<Created>("campflare.invites.create", args, token)
}

function accept(url: string, args: Record<string, unknown>, ip?: string) {
  return anonymous<Joined>(
    "campflare.invites.accept",
    { code: url, password: "a long enough password", email: uniqueEmail("x"), ...args },
    ip,
  )
}

/** The invite list's row for an id. */
async function listed(token: string, id: string) {
  const { invites } = await ok<{ invites: Invite[] }>("campflare.invites.list", {}, token)
  return invites.find((i) => i.id === id)
}

afterEach(() => setEmailSender(undefined))

describe("campflare.invites.create", () => {
  it("answers a /join link, shown once and stored only as a hash", async () => {
    const w = await workspace()
    const res = await invite(w.owner.token)
    expect(res.url).toMatch(new RegExp(`^${ORIGIN}/join/[0-9a-f]{64}$`))
    expect(res.invite).toMatchObject({ role: "member", max_uses: 1, uses: 0, state: "pending", email: null })
    expect(res.emailed).toBe(false)
    const row = await env.DB.prepare("SELECT * FROM invites WHERE id = ?").bind(res.invite.id).first<{ hash: string }>()
    expect(JSON.stringify(row)).not.toContain(codeOf(res.url))
    expect(await listed(w.owner.token, res.invite.id)).toMatchObject({ state: "pending", inviter_name: "owner" })
    expect(JSON.stringify(await ok("campflare.invites.list", {}, w.owner.token))).not.toContain(codeOf(res.url))
  })

  it("is for admins, and an admin invite for owners", async () => {
    const w = await workspace()
    const bob = await w.addUser("bob")
    const ada = await w.addUser("ada", { is_admin: true })
    await expectError("campflare.invites.create", {}, bob.token, "not_an_admin")
    await expectError("campflare.invites.list", {}, bob.token, "not_an_admin")
    await expectError("campflare.invites.create", { role: "admin" }, ada.token, "not_an_owner")
    await expectError("campflare.invites.create", { role: "owner" }, w.owner.token, "invalid_arguments")
    await invite(ada.token)
    expect((await invite(w.owner.token, { role: "admin" })).invite.role).toBe("admin")
  })

  it("wants admin.invites scopes", async () => {
    const w = await workspace()
    const reader = (await ok<{ token: string }>("campflare.tokens.create", { preset: "read" }, w.owner.token)).token
    await expectError("campflare.invites.create", {}, reader, "missing_scope")
    await expectError("campflare.invites.list", {}, reader, "missing_scope")
    const lister = (
      await ok<{ token: string }>("campflare.tokens.create", { scopes: "admin.invites:read" }, w.owner.token)
    ).token
    await ok("campflare.invites.list", {}, lister)
    await expectError("campflare.invites.revoke", { invite: "I0" }, lister, "missing_scope")
  })

  it("checks its arguments", async () => {
    const w = await workspace()
    const t = w.owner.token
    await expectError("campflare.invites.create", { expires_in: 30 }, t, "invalid_arguments")
    await expectError("campflare.invites.create", { expires_in: 31 * 86_400 }, t, "invalid_arguments")
    await expectError("campflare.invites.create", { expires_in: "soon" }, t, "invalid_arguments")
    await expectError("campflare.invites.create", { max_uses: 0 }, t, "invalid_arguments")
    await expectError("campflare.invites.create", { max_uses: 1001 }, t, "invalid_arguments")
    await expectError("campflare.invites.create", { email: "not an email" }, t, "invalid_email")
    await expectError("campflare.invites.create", { email: uniqueEmail("a"), max_uses: 2 }, t, "invalid_arguments")
    const bobEmail = uniqueEmail("bob")
    await w.addUser("bob", { email: bobEmail })
    await expectError("campflare.invites.create", { email: bobEmail.toUpperCase() }, t, "already_in_team")
  })

  it("brings people only into channels the inviter could", async () => {
    const w = await workspace()
    const ada = await w.addUser("ada", { is_admin: true })
    const { channel: secret } = await ok<{ channel: { id: string } }>(
      "conversations.create",
      { name: "secret", is_private: true },
      w.owner.token,
    )
    const res = await call("campflare.invites.create", { channels: `${secret.id},CNOPE` }, ada.token)
    expect(res).toMatchObject({ ok: false, error: "channel_not_found", channels: [secret.id, "CNOPE"] })
    await invite(w.owner.token, { channels: secret.id })
  })

  it("mails an invite to its address when the server can send email", async () => {
    const sent: EmailMessage[] = []
    setEmailSender({ send: async (m) => void sent.push(m) })
    const w = await workspace()
    const email = uniqueEmail("zoe")
    const res = await invite(w.owner.token, { email })
    expect(res.emailed).toBe(true)
    await eventually(() => sent.length === 1)
    expect(sent[0]).toMatchObject({ to: email })
    expect(sent[0]!.text).toContain(res.url)
  })

  it("answers the URL even when sending the email fails", async () => {
    let tried = 0
    setEmailSender({
      send: async () => {
        tried++
        throw new Error("provider down")
      },
    })
    const w = await workspace()
    const res = await invite(w.owner.token, { email: uniqueEmail("ada") })
    expect(res.url).toMatch(/\/join\/[0-9a-f]{64}$/)
    await eventually(() => tried === 1)
    expect((await accept(res.url, { name: "ada", email: undefined })).ok).toBe(true)
  })
})

describe("email addresses", () => {
  it("are one shape everywhere: trimmed, lower case, something@domain.tld", async () => {
    expect(normalizeEmail("  Zoé@Example.TEST ")).toBe("zoé@example.test")
    expect(isEmail("zoé@example.test")).toBe(true)
    expect(isEmail("no spaces@example.test")).toBe(false)
    expect(isEmail("nodomain@example")).toBe(false)
    const w = await workspace()
    const email = uniqueEmail("Zoé")
    const created = await invite(w.owner.token, { email: `  ${email.toUpperCase()} ` })
    expect(created.invite.email).toBe(email.toLowerCase())
    const joined = await accept(created.url, { name: "zoe", email: ` ${email} ` })
    expect(joined.user.profile.email).toBe(email.toLowerCase())
    // users.create stores it the same way, so an invite to it is already_in_team.
    const other = uniqueEmail("Øyvind")
    await ok("campflare.users.create", { name: "oyvind", email: ` ${other.toUpperCase()}` }, w.owner.token)
    await expectError("campflare.invites.create", { email: other }, w.owner.token, "already_in_team")
  })
})

describe("campflare.invites.accept", () => {
  it("adds the person with a full token, a password, #general and the invite's channels", async () => {
    const w = await workspace()
    const { channel: dev } = await ok<{ channel: { id: string } }>(
      "conversations.create",
      { name: "dev" },
      w.owner.token,
    )
    const { url } = await invite(w.owner.token, { channels: dev.id })
    const email = uniqueEmail("Mei")
    const joined = await accept(url, { name: "@Mei", real_name: "王美玲", email, password: "我的密碼很安全啊對吧" })
    expect(joined.ok).toBe(true)
    expect(joined.user).toMatchObject({ name: "mei", is_admin: false, profile: { email: email.toLowerCase() } })
    expect(joined.token).toMatch(/^xoxp-/)
    const whoami = await SELF.fetch(`${ORIGIN}/api/auth.test`, { headers: { authorization: `Bearer ${joined.token}` } })
    expect(whoami.headers.get("x-oauth-scopes")).toContain("admin.invites:write")
    const { channels } = await ok<{ channels: { id: string }[] }>("users.conversations", {}, joined.token)
    expect(channels.map((c) => c.id).toSorted()).toEqual([dev.id, w.general].toSorted())
    expect((await signIn(email, "我的密碼很安全啊對吧")).status).toBe(200)
  })

  it("takes the whole link or the code alone", async () => {
    const w = await workspace()
    const { url } = await invite(w.owner.token)
    expect((await accept(codeOf(url), { name: "léa" })).error).toBe("invalid_name")
    expect((await accept(codeOf(url), { name: "lea" })).ok).toBe(true)
  })

  it("tells the workspace: team_join, and member_joined_channel to each channel's members", async () => {
    const w = await workspace()
    const { channel: dev } = await ok<{ channel: { id: string } }>(
      "conversations.create",
      { name: "dev" },
      w.owner.token,
    )
    const rtm = await ok<{ url: string }>("rtm.connect", {}, w.owner.token)
    const link = await connect(rtm.url)
    await link.next((f) => f.type === "hello")
    const { url } = await invite(w.owner.token, { channels: dev.id })
    const joined = await accept(url, { name: "jose", real_name: "José Núñez" })
    const event = await link.next((f) => f.type === "team_join")
    expect(event).toMatchObject({ user: { id: joined.user.id, name: "jose", real_name: "José Núñez" } })
    const joins = [
      await link.next((f) => f.type === "member_joined_channel"),
      await link.next((f) => f.type === "member_joined_channel"),
    ]
    expect(joins.map((j) => j.channel).toSorted()).toEqual([dev.id, w.general].toSorted())
    expect(joins[0]).toMatchObject({ user: joined.user.id, channel_type: "C", inviter: w.owner.id })
    link.close()
  })

  it("admits at most max_uses people, then says it's used up", async () => {
    const w = await workspace()
    const { url, invite: created } = await invite(w.owner.token, { max_uses: 2 })
    expect((await accept(url, { name: "kim" })).ok).toBe(true)
    expect((await accept(url, { name: "park" })).ok).toBe(true)
    expect((await accept(url, { name: "lee" })).error).toBe("invite_used_up")
    expect(await listed(w.owner.token, created.id)).toMatchObject({ uses: 2, state: "used_up" })
  })

  it("refuses an expired or revoked invite", async () => {
    const w = await workspace()
    const expired = await invite(w.owner.token)
    await env.DB.prepare("UPDATE invites SET expires = 1 WHERE id = ?").bind(expired.invite.id).run()
    expect((await accept(expired.url, { name: "late" })).error).toBe("invite_expired")
    expect(await listed(w.owner.token, expired.invite.id)).toMatchObject({ state: "expired" })

    const revoked = await invite(w.owner.token)
    const ada = await w.addUser("ada", { is_admin: true })
    const res = await ok<{ invite: Invite }>("campflare.invites.revoke", { invite: revoked.invite.id }, ada.token)
    expect(res.invite.state).toBe("revoked")
    expect((await accept(revoked.url, { name: "nope" })).error).toBe("invite_revoked")
    await expectError("campflare.invites.revoke", { invite: "IXXXX" }, w.owner.token, "invite_not_found")
    await expectError("campflare.invites.revoke", {}, w.owner.token, "invite_not_found")
    const other = await workspace()
    await expectError("campflare.invites.revoke", { invite: revoked.invite.id }, other.owner.token, "invite_not_found")
  })

  it("binds an invite to its email", async () => {
    const w = await workspace()
    const email = uniqueEmail("Chloé")
    const { url } = await invite(w.owner.token, { email })
    expect((await accept(url, { name: "chloe", email: uniqueEmail("other") })).error).toBe("email_mismatch")
    const joined = await anonymous<Joined>("campflare.invites.accept", {
      code: url,
      name: "chloe",
      password: "Mot de passe sûr",
    })
    expect(joined.user.profile.email).toBe(email.toLowerCase())
  })

  it("needs an email, a handle and a good password from an open link", async () => {
    const w = await workspace()
    const { url } = await invite(w.owner.token)
    const open = { code: url, name: "ana", password: "Contraseña-Ñandú" }
    expect((await anonymous("campflare.invites.accept", open)).error).toBe("email_required")
    expect((await anonymous("campflare.invites.accept", { ...open, email: "nope" })).error).toBe("invalid_email")
    expect((await accept(url, { name: "ana", password: "short" })).error).toBe("invalid_password")
    expect((await anonymous("campflare.invites.accept", { code: url, name: "ana" })).error).toBe("invalid_arguments")
  })

  it("spends no use on a handle or email that's taken", async () => {
    const w = await workspace()
    const takenEmail = uniqueEmail("taken")
    await w.addUser("bob", { email: takenEmail })
    const { url, invite: created } = await invite(w.owner.token)
    expect((await accept(url, { name: "bob" })).error).toBe("name_taken")
    expect((await accept(url, { name: "robert", email: takenEmail })).error).toBe("already_in_team")
    expect(await listed(w.owner.token, created.id)).toMatchObject({ uses: 0, state: "pending" })
    expect((await accept(url, { name: "robert" })).ok).toBe(true)
  })

  it("makes an admin from an admin invite, while its owner still is one", async () => {
    const w = await workspace()
    const { url } = await invite(w.owner.token, { role: "admin" })
    expect((await accept(url, { name: "ada" })).user.is_admin).toBe(true)

    // A demoted or deactivated inviter's invites stop working.
    const eve = await w.addUser("eve", { is_admin: true })
    const fromEve = await invite(eve.token)
    await ok("campflare.users.setRole", { user: eve.id, role: "member" }, w.owner.token)
    expect((await accept(fromEve.url, { name: "fred" })).error).toBe("invalid_invite")
    await ok("campflare.users.setRole", { user: eve.id, role: "admin" }, w.owner.token)
    expect((await accept(fromEve.url, { name: "fred" })).ok).toBe(true)
  })

  it("throttles guessing codes by address, and every attempt by rate", async () => {
    const ip = freshIp()
    const bogus = "0".repeat(64)
    for (let i = 0; i < IP_FREE_FAILURES; i++) {
      expect((await accept(bogus, { name: "guess" }, ip)).error).toBe("invalid_invite")
    }
    const blocked = await accept(bogus, { name: "guess" }, ip)
    expect(blocked).toMatchObject({ error: "too_many_attempts" })
    expect((blocked as unknown as { retry_after: number }).retry_after).toBeGreaterThan(0)

    const w = await workspace()
    const { url } = await invite(w.owner.token)
    const busy = freshIp()
    for (let i = 0; i < RATE_LIMIT; i++) await accept(url, { name: "x", password: "short" }, busy)
    expect((await accept(url, { name: "x" }, busy)).error).toBe("too_many_attempts")
    expect((await accept(url, { name: "x" })).ok).toBe(true)
  })
})

/** Posts a form as a browser would. */
const postForm = (path: string, form: Record<string, string>, ip = freshIp()) =>
  browser().go(path, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", "cf-connecting-ip": ip },
    body: new URLSearchParams(form),
  })

describe("the /join page", () => {
  it("shows a script-free form whose POST may lead to the app", async () => {
    const w = await workspace("Équipe 東京")
    const { url } = await invite(w.owner.token)
    const res = await browser().go(url)
    expect(res.status).toBe(200)
    const csp = res.headers.get("content-security-policy")!
    expect(csp).toContain("default-src 'none'")
    expect(csp).toContain("form-action 'self' https://app.campflare.test;")
    expect(csp).not.toContain("script-src")
    expect(res.headers.get("referrer-policy")).toBe("no-referrer")
    const html = await res.text()
    expect(html).toContain("Join Équipe 東京")
    expect(html).toContain("Olive Owner invited you")
    expect(html).toContain('name="email"')
    expect(html).not.toContain("<script")
  })

  it("shows a bound email instead of asking for one", async () => {
    const w = await workspace()
    const email = uniqueEmail("sora")
    const { url } = await invite(w.owner.token, { email, role: "admin" })
    const html = await (await browser().go(url)).text()
    expect(html).toContain(email.toLowerCase())
    expect(html).toContain("as an admin")
    expect(html).not.toContain('name="email"')
  })

  it("joins, signs in and sends the person to the app", async () => {
    const w = await workspace()
    const { url } = await invite(w.owner.token)
    const password = "パスワードは秘密です"
    const email = uniqueEmail("yuki")
    const res = await postForm(new URL(url).pathname, {
      name: "yuki",
      real_name: "佐藤 雪",
      email,
      password,
      password_again: password,
    })
    expect(res.status).toBe(302)
    expect(res.headers.get("location")).toBe("https://app.campflare.test/?team=dev")
    expect(res.headers.getSetCookie().join(";")).toContain("session_token")
    expect((await signIn(email, password)).status).toBe(200)
  })

  it("keeps what was typed and says what's wrong", async () => {
    const w = await workspace()
    await w.addUser("taken")
    const { url } = await invite(w.owner.token)
    const path = new URL(url).pathname
    const base = { name: "Taken", real_name: "Ana Núñez", email: uniqueEmail("ana") }
    const differ = await postForm(path, { ...base, password: "first password", password_again: "second password" })
    expect(differ.status).toBe(400)
    const html = await differ.text()
    expect(html).toContain("The two passwords differ.")
    expect(html).toContain('value="Ana Núñez"')
    expect(html).not.toContain("first password")
    const taken = await postForm(path, { ...base, password: "long enough!", password_again: "long enough!" })
    expect(await taken.text()).toContain("@taken is taken")
    const short = await postForm(path, { ...base, name: "ana", password: "short", password_again: "short" })
    expect(await short.text()).toContain("A password needs at least 10 characters.")
    const badEmail = await postForm(path, { ...base, name: "ana", email: "x", password: "x", password_again: "x" })
    expect(await badEmail.text()).toContain("doesn&#39;t look like an email")
    const missing = await postForm(path, { name: "ana", password: "x", password_again: "x" })
    expect(await missing.text()).toContain("Enter your email address")
  })

  it("explains a dead link without a form", async () => {
    const w = await workspace()
    const unknown = await browser().go(`/join/${"0".repeat(64)}`)
    expect(unknown.status).toBe(404)
    expect(await unknown.text()).toContain("doesn't work")
    expect((await browser().go("/join/not-a-code")).status).toBe(404)
    const { url, invite: created } = await invite(w.owner.token)
    await ok("campflare.invites.revoke", { invite: created.id }, w.owner.token)
    const gone = await browser().go(url)
    expect(gone.status).toBe(410)
    expect(await gone.text()).toContain("withdrawn")
    const posted = await postForm(new URL(url).pathname, { name: "x", password: "x", password_again: "x" })
    expect(posted.status).toBe(410)
    expect((await postForm(`/join/${"1".repeat(64)}`, { name: "x" })).status).toBe(404)
  })

  it("answers 429 when the address has tried too often", async () => {
    const w = await workspace()
    const { url } = await invite(w.owner.token)
    const ip = freshIp()
    for (let i = 0; i < RATE_LIMIT; i++) await accept(url, { name: "x", password: "short" }, ip)
    const res = await postForm(
      new URL(url).pathname,
      { name: "x", password: "long enough!", password_again: "long enough!" },
      ip,
    )
    expect(res.status).toBe(429)
    expect(Number(res.headers.get("retry-after"))).toBeGreaterThan(0)
    expect(await res.text()).toContain("Too many")
  })

  it("says what to do next when there's no app to send the person to", async () => {
    const headers = new Headers({ "set-cookie": "a=b" })
    const res = joinedPage(new URL(`${ORIGIN}/join/x`), { origin: ORIGIN, team: "Team ☕" }, "mia", headers)
    const html = await res.text()
    expect(html).toContain("Welcome to Team ☕")
    expect(html).toContain(`campflare login --url ${ORIGIN} --oauth`)
    expect(html).not.toContain("Open Campflare")
    expect(res.headers.getSetCookie()).toEqual(["a=b"])
    const withApp = joinedPage(
      new URL(`${ORIGIN}/join/x`),
      { origin: ORIGIN, team: "T", appUrl: "https://app.test/" },
      "mia",
    )
    expect(await withApp.text()).toContain('href="https://app.test/"')
  })
})

type Reset = { url: string; user_id: string; expires: number }

describe("campflare.users.createPasswordReset", () => {
  it("takes a role above the person's", async () => {
    const w = await workspace()
    const bob = await w.addUser("bob")
    const ada = await w.addUser("ada", { is_admin: true })
    const eve = await w.addUser("eve", { is_admin: true })
    const res = await ok<Reset>("campflare.users.createPasswordReset", { user: bob.id }, ada.token)
    expect(res.url).toMatch(new RegExp(`^${ORIGIN}/reset/[0-9a-f]{64}$`))
    expect(res.expires - Math.floor(Date.now() / 1000)).toBeGreaterThan(3500)
    await expectError("campflare.users.createPasswordReset", { user: ada.id }, bob.token, "not_an_admin")
    await expectError("campflare.users.createPasswordReset", { user: eve.id }, ada.token, "not_an_owner")
    await expectError("campflare.users.createPasswordReset", { user: w.owner.id }, ada.token, "cant_act_on_owner")
    await expectError("campflare.users.createPasswordReset", { user: w.owner.id }, w.owner.token, "cant_act_on_owner")
    await ok("campflare.users.createPasswordReset", { user: eve.id }, w.owner.token)
    await expectError("campflare.users.createPasswordReset", {}, w.owner.token, "user_not_found")
    const app = await w.addApp("Robot")
    await expectError("campflare.users.createPasswordReset", { user: app.botUserId }, w.owner.token, "user_is_bot")
    const noEmail = await ok<{ user: { id: string } }>("campflare.users.create", { name: "nomail" }, w.owner.token)
    await expectError("campflare.users.createPasswordReset", { user: noEmail.user.id }, w.owner.token, "email_required")
    await expectError(
      "campflare.users.createPasswordReset",
      { user: bob.id, expires_in: 60 },
      w.owner.token,
      "invalid_arguments",
    )
  })
})

describe("resetting a password through a link", () => {
  async function person() {
    const w = await workspace()
    const email = uniqueEmail("hana")
    const hana = await w.addUser("hana", { email, password: "the old password" })
    const reset = await ok<Reset>("campflare.users.createPasswordReset", { user: hana.id }, w.owner.token)
    return { w, email, hana, reset }
  }

  it("sets the new password once, and keeps the link through a refused one", async () => {
    const { email, hana, reset } = await person()
    const short = await anonymous("campflare.users.resetPassword", { code: reset.url, password: "short" })
    expect(short.error).toBe("invalid_password")
    const res = await anonymous("campflare.users.resetPassword", {
      code: reset.url,
      password: "花は咲く、春の日に咲く",
    })
    expect(res).toMatchObject({ ok: true, user_id: hana.id })
    expect((await signIn(email, "花は咲く、春の日に咲く")).status).toBe(200)
    expect((await signIn(email, "the old password")).status).toBe(401)
    const again = await anonymous("campflare.users.resetPassword", { code: reset.url, password: "yet another one" })
    expect(again.error).toBe("invalid_reset")
  })

  it("forgets an earlier link when a new one is made, and a deactivated person's", async () => {
    const { w, hana, reset } = await person()
    const newer = await ok<Reset>("campflare.users.createPasswordReset", { user: hana.id }, w.owner.token)
    const old = await anonymous("campflare.users.resetPassword", { code: reset.url, password: "long enough now" })
    expect(old.error).toBe("invalid_reset")
    await ok("campflare.users.deactivate", { user: hana.id }, w.owner.token)
    const gone = await anonymous("campflare.users.resetPassword", { code: newer.url, password: "long enough now" })
    expect(gone.error).toBe("invalid_reset")
  })

  it("refuses an expired link", async () => {
    const { reset } = await person()
    await env.DB.prepare("UPDATE password_resets SET expires = 1").run()
    const res = await anonymous("campflare.users.resetPassword", { code: reset.url, password: "long enough now" })
    expect(res.error).toBe("invalid_reset")
  })

  it("throttles guessing", async () => {
    const ip = freshIp()
    for (let i = 0; i < IP_FREE_FAILURES; i++) {
      await anonymous("campflare.users.resetPassword", { code: "f".repeat(64), password: "long enough now" }, ip)
    }
    const res = await anonymous("campflare.users.resetPassword", { code: "f".repeat(64), password: "long enough" }, ip)
    expect(res.error).toBe("too_many_attempts")
  })

  it("has a page that does the same", async () => {
    const { email, reset } = await person()
    const path = new URL(reset.url).pathname
    const shown = await browser().go(path)
    expect(shown.status).toBe(200)
    expect(shown.headers.get("content-security-policy")).toContain("form-action 'self';")
    expect(shown.headers.get("referrer-policy")).toBe("no-referrer")
    expect(await shown.text()).toContain("@hana")
    const differ = await postForm(path, { password: "one password", password_again: "another one" })
    expect(await differ.text()).toContain("The two passwords differ.")
    const short = await postForm(path, { password: "short", password_again: "short" })
    expect(short.status).toBe(400)
    expect(await short.text()).toContain("at least 10 characters")
    const done = await postForm(path, { password: "Größenwahn-Straße", password_again: "Größenwahn-Straße" })
    expect(done.status).toBe(200)
    expect(await done.text()).toContain("Password changed")
    expect((await signIn(email, "Größenwahn-Straße")).status).toBe(200)
    expect((await browser().go(path)).status).toBe(404)
    expect((await postForm(path, { password: "x", password_again: "x" })).status).toBe(404)
  })

  it("answers 429 on the page when the address has tried too often", async () => {
    const { reset } = await person()
    const ip = freshIp()
    for (let i = 0; i < RATE_LIMIT; i++) {
      await anonymous("campflare.users.resetPassword", { code: "e".repeat(64), password: "x" }, ip)
    }
    const res = await postForm(
      new URL(reset.url).pathname,
      { password: "long enough!", password_again: "long enough!" },
      ip,
    )
    expect(res.status).toBe(429)
  })

  it("takes the code alone too", async () => {
    const { reset } = await person()
    const code = reset.url.split("/reset/")[1]!
    expect(await anonymous("campflare.users.resetPassword", { code, password: "long enough now" })).toMatchObject({
      ok: true,
    })
  })
})

describe("asking for your own reset", () => {
  it("says plainly when the server can't send email", async () => {
    const res = await anonymous("campflare.users.requestPasswordReset", { email: "a@example.test" })
    expect(res.error).toBe("email_not_configured")
    expect(JSON.stringify(res)).toContain("ask an admin")
    const page = await browser().go("/reset")
    expect(await page.text()).toContain("campflare admin reset-password")
    expect(await (await postForm("/reset", { email: "a@example.test" })).text()).toContain("ask an admin")
    const login = await (await browser().go("/login")).text()
    expect(login).toContain('href="/reset"')
  })

  it("mails a link to each person with the email, and answers alike for unknown ones", async () => {
    const sent: EmailMessage[] = []
    setEmailSender({ send: async (m) => void sent.push(m) })
    const w = await workspace()
    const email = uniqueEmail("ines")
    await w.addUser("ines", { email, password: "the old password" })
    await ok("campflare.users.requestPasswordReset", { email: email.toUpperCase() })
    await eventually(() => sent.length === 1)
    const link = /https:\S+\/reset\/[0-9a-f]{64}/.exec(sent[0]!.text)![0]
    expect(sent[0]!.to).toBe(email)
    await anonymous("campflare.users.resetPassword", { code: link, password: "Inès a changé" })
    expect((await signIn(email, "Inès a changé")).status).toBe(200)

    await ok("campflare.users.requestPasswordReset", { email: uniqueEmail("nobody"), workspace: "elsewhere" })
    await expectError("campflare.users.requestPasswordReset", { email: "nope" }, undefined, "invalid_email")
    expect(sent).toHaveLength(1)
  })

  it("limits how many links one address is sent", async () => {
    setEmailSender({ send: async () => {} })
    const email = uniqueEmail("flood")
    for (let i = 0; i < 3; i++) await anonymous("campflare.users.requestPasswordReset", { email })
    const res = await anonymous("campflare.users.requestPasswordReset", { email })
    expect(res.error).toBe("too_many_attempts")
  })

  it("has a form at /reset", async () => {
    const sent: EmailMessage[] = []
    setEmailSender({ send: async (m) => void sent.push(m) })
    expect(await (await browser().go("/reset")).text()).toContain('name="email"')
    const done = await postForm("/reset", { email: uniqueEmail("nobody") })
    expect(await done.text()).toContain("Check your email")
    const bad = await postForm("/reset", { email: "nope" })
    expect(bad.status).toBe(400)
    const email = uniqueEmail("busy")
    for (let i = 0; i < 3; i++) await postForm("/reset", { email })
    expect((await postForm("/reset", { email })).status).toBe(429)
  })

  it("keeps answering when sending fails", async () => {
    setEmailSender({ send: () => Promise.reject(new Error("provider down")) })
    const w = await workspace()
    const email = uniqueEmail("leo")
    await w.addUser("leo", { email })
    await ok("campflare.users.requestPasswordReset", { email })
  })
})

describe("the link pages refuse cross-site posts (login CSRF)", () => {
  /** A form POST as another site's page would send it. */
  const crossPost = (path: string, form: Record<string, string>, headers: Record<string, string>) =>
    SELF.fetch(`${ORIGIN}${path}`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", "cf-connecting-ip": freshIp(), ...headers },
      body: new URLSearchParams(form),
      redirect: "manual",
    })

  it("on /join: no account, no session", async () => {
    const w = await workspace()
    const { url, invite: created } = await invite(w.owner.token)
    const form = {
      name: "mallory",
      email: uniqueEmail("mallory"),
      password: "a long enough password",
      password_again: "a long enough password",
    }
    const path = new URL(url).pathname
    for (const headers of <Record<string, string>[]>[
      { origin: "https://evil.test" },
      { origin: "null" },
      { "sec-fetch-site": "cross-site" },
      { "sec-fetch-site": "same-site" },
    ]) {
      const res = await crossPost(path, form, headers)
      expect(res.status).toBe(403)
      expect(res.headers.getSetCookie()).toEqual([])
      expect(await res.text()).toContain("only be sent from this site")
    }
    expect(await listed(w.owner.token, created.id)).toMatchObject({ uses: 0 })
    const same = await crossPost(path, form, { origin: ORIGIN, "sec-fetch-site": "same-origin" })
    expect(same.status).toBe(302)
  })

  it("on /reset/<code> and /reset", async () => {
    const w = await workspace()
    const email = uniqueEmail("rosa")
    const rosa = await w.addUser("rosa", { email, password: "the old password" })
    const reset = await ok<Reset>("campflare.users.createPasswordReset", { user: rosa.id }, w.owner.token)
    const form = { password: "Rosa's new one!", password_again: "Rosa's new one!" }
    const evil = { origin: "https://evil.test" }
    expect((await crossPost(new URL(reset.url).pathname, form, evil)).status).toBe(403)
    expect((await signIn(email, "the old password")).status).toBe(200)
    expect((await crossPost("/reset", { email }, { "sec-fetch-site": "cross-site" })).status).toBe(403)
    // No Origin and no Sec-Fetch-Site: not a browser, so no one's cookies; allowed.
    expect((await crossPost(new URL(reset.url).pathname, form, {})).status).toBe(200)
  })
})
