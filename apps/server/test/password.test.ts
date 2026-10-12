import { SELF } from "cloudflare:test"
import { env } from "cloudflare:workers"
import { describe, expect, it } from "vitest"
import { hashPassword, MAX_FAILURES, verifyPassword } from "../src/auth/password"
import { browser } from "./browser"
import { call, expectError, ORIGIN, ok, workspace } from "./helpers"

const signIn = (body: Record<string, string>) =>
  SELF.fetch(`${ORIGIN}/auth/sign-in/campflare-password`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: ORIGIN },
    body: JSON.stringify(body),
  })

async function signInAnswer(body: Record<string, string>) {
  const res = await signIn(body)
  return {
    status: res.status,
    body: (await res.json()) as { message?: string; campflare_user?: string; team?: string },
  }
}

let n = 0
/** An address no other test uses, so tests don't see each other's people. */
const uniqueEmail = (name: string) => `${name}-${++n}-${Date.now()}@example.test`

describe("campflare.users.setPassword", () => {
  it("sets the caller's password, in any script, and never answers with it", async () => {
    const w = await workspace()
    const email = uniqueEmail("mei")
    const mei = await w.addUser("mei", { email })
    for (const password of [
      "我的密碼很安全啊對吧",
      "パスワードは秘密です",
      "비밀번호는안전해요1",
      "Contraseña-Ñandú",
      "Mot de passe sûr",
      "Größenwahn-Straße",
    ]) {
      const res = await ok("campflare.users.setPassword", { password }, mei.token)
      expect(JSON.stringify(res)).not.toContain(password)
      expect((await signInAnswer({ email, password })).status).toBe(200)
    }
  })

  it("refuses short or blank passwords, a missing one, and people without an email", async () => {
    const w = await workspace()
    const bob = await w.addUser("bob")
    const short = await expectError(
      "campflare.users.setPassword",
      { password: "短い密码" },
      bob.token,
      "invalid_password",
    )
    expect(JSON.stringify(short.response_metadata)).toContain("at least 10 characters")
    await expectError("campflare.users.setPassword", { password: " ".repeat(12) }, bob.token, "invalid_password")
    await expectError("campflare.users.setPassword", { password: "x".repeat(1025) }, bob.token, "invalid_password")
    await expectError("campflare.users.setPassword", {}, bob.token, "invalid_arguments")
    const noEmail = await ok<{ token: string }>("campflare.users.create", { name: "noemail" }, w.owner.token)
    await expectError("campflare.users.setPassword", { password: "long enough now" }, noEmail.token, "email_required")
  })

  it("is for people, not bots", async () => {
    const w = await workspace()
    const app = await w.addApp("Robot")
    const res = await call("campflare.users.setPassword", { password: "long enough now" }, app.botToken)
    expect(res.ok).toBe(false)
  })

  it("lets an admin give a new person a first password", async () => {
    const w = await workspace()
    const email = uniqueEmail("lea")
    await ok("campflare.users.create", { name: "lea", email, password: "Léa a un bon mot" }, w.owner.token)
    expect((await signInAnswer({ email, password: "Léa a un bon mot" })).status).toBe(200)
    await expectError(
      "campflare.users.create",
      { name: "nomail", password: "long enough now" },
      w.owner.token,
      "email_required",
    )
    await expectError(
      "campflare.users.create",
      { name: "short", email: uniqueEmail("short"), password: "short" },
      w.owner.token,
      "invalid_password",
    )
  })
})

describe("signing in with an email and a password", () => {
  it("signs in the person whose password it is, whatever the email's case", async () => {
    const w = await workspace()
    const email = uniqueEmail("hana")
    const hana = await w.addUser("hana", { email })
    await ok("campflare.users.setPassword", { password: "花は咲く、春の日に咲く" }, hana.token)
    const res = await signIn({ email: email.toUpperCase(), password: "花は咲く、春の日に咲く" })
    expect(res.status).toBe(200)
    expect(res.headers.getSetCookie().join(";")).toContain("session_token")
    expect(await res.json()).toMatchObject({ campflare_user: hana.id, team: w.teamId })
  })

  it("refuses a wrong password and an unknown email alike", async () => {
    const w = await workspace()
    const email = uniqueEmail("jose")
    const jose = await w.addUser("jose", { email })
    await ok("campflare.users.setPassword", { password: "José come jamón" }, jose.token)
    expect(await signInAnswer({ email, password: "José come queso" })).toMatchObject({
      status: 401,
      body: { message: "invalid_credentials" },
    })
    expect(await signInAnswer({ email: uniqueEmail("nobody"), password: "José come jamón" })).toMatchObject({
      status: 401,
      body: { message: "invalid_credentials" },
    })
  })

  it("asks for the workspace only when the password fits the email in more than one", async () => {
    const email = uniqueEmail("ji-woo")
    const first = await workspace()
    const second = await workspace()
    const third = await workspace()
    const a = await first.addUser("jiwoo", { email })
    const b = await second.addUser("jiwoo", { email })
    const c = await third.addUser("jiwoo", { email })
    await ok("campflare.users.setPassword", { password: "우리 같은 비밀번호예요" }, a.token)
    await ok("campflare.users.setPassword", { password: "우리 같은 비밀번호예요" }, b.token)
    await ok("campflare.users.setPassword", { password: "Ein anderes Wort" }, c.token)

    // A password of one workspace only: no question.
    expect((await signInAnswer({ email, password: "Ein anderes Wort" })).body.campflare_user).toBe(c.id)
    // The same password in two: which one?
    expect(await signInAnswer({ email, password: "우리 같은 비밀번호예요" })).toMatchObject({
      status: 400,
      body: { message: "workspace_required" },
    })
    const domain = (team: string) =>
      env.DB.prepare("SELECT domain, name FROM teams WHERE id = ?").bind(team).first<{ domain: string; name: string }>()
    const firstTeam = (await domain(first.teamId))!
    const secondTeam = (await domain(second.teamId))!
    expect(
      (await signInAnswer({ email, password: "우리 같은 비밀번호예요", workspace: firstTeam.domain })).body
        .campflare_user,
    ).toBe(a.id)
    expect(
      (await signInAnswer({ email, password: "우리 같은 비밀번호예요", workspace: secondTeam.name.toUpperCase() })).body
        .campflare_user,
    ).toBe(b.id)
    // The wrong workspace for that password is just a wrong password.
    expect((await signInAnswer({ email, password: "Ein anderes Wort", workspace: firstTeam.domain })).status).toBe(401)
  })

  it("stops a deactivated person", async () => {
    const w = await workspace()
    const email = uniqueEmail("chloe")
    const chloe = await w.addUser("chloe", { email })
    await ok("campflare.users.setPassword", { password: "Chloé chante fort" }, chloe.token)
    await ok("campflare.users.deactivate", { user: chloe.id }, w.owner.token)
    expect((await signInAnswer({ email, password: "Chloé chante fort" })).status).toBe(401)
  })

  it("locks a person out for a while after too many wrong passwords", async () => {
    const w = await workspace()
    const email = uniqueEmail("wei")
    const wei = await w.addUser("wei", { email })
    await ok("campflare.users.setPassword", { password: "长城不是一天建成的哦" }, wei.token)
    for (let i = 0; i < MAX_FAILURES; i++) {
      expect((await signInAnswer({ email, password: `猜错了第${i}次啊啊啊` })).status).toBe(401)
    }
    // Even the right password waits now.
    expect(await signInAnswer({ email, password: "长城不是一天建成的哦" })).toMatchObject({
      status: 429,
      body: { message: "too_many_attempts" },
    })
    const page = await browser().go("/login", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ email, password: "长城不是一天建成的哦" }),
    })
    expect(await page.text()).toContain("Too many wrong passwords")
    // Setting the password again (with the token) lifts the lock.
    await ok("campflare.users.setPassword", { password: "长城不是一天建成的哦" }, wei.token)
    expect((await signInAnswer({ email, password: "长城不是一天建成的哦" })).status).toBe(200)
  })

  it("shows the workspace question and errors on the sign-in page", async () => {
    const email = uniqueEmail("ines")
    for (const w of [await workspace(), await workspace()]) {
      const ines = await w.addUser("ines", { email })
      await ok("campflare.users.setPassword", { password: "Inès aime le café" }, ines.token)
    }
    const post = (form: Record<string, string>) =>
      browser().go("/login", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams(form),
      })
    const ambiguous = await (await post({ email, password: "Inès aime le café" })).text()
    expect(ambiguous).toContain("more than one workspace")
    expect(ambiguous).toContain('name="workspace"')
    expect(ambiguous).toContain(`value="${email}"`)
    expect(ambiguous).not.toContain("Inès aime le café")

    const wrong = await (await post({ email, password: "Inès aime le thé" })).text()
    expect(wrong).toContain("That email and password don&#39;t match.")
    expect(wrong).not.toContain('name="workspace"')

    const unknown = await (await post({ email: uniqueEmail("none"), password: "x", workspace: "nowhere" })).text()
    expect(unknown).toContain('name="workspace"') // asked once, kept asking
  })
})

describe("password hashes", () => {
  it("salts each hash, treats composed and decomposed accents alike, and rejects unknown schemes", async () => {
    const composed = "Crème brûlée"
    const decomposed = composed.normalize("NFD")
    const one = await hashPassword(composed)
    expect(one).not.toBe(await hashPassword(composed))
    expect(one).toMatch(/^pbkdf2-sha256\$100000\$/)
    expect(await verifyPassword(decomposed, one)).toBe(true)
    expect(await verifyPassword("Creme brulee", one)).toBe(false)
    expect(await verifyPassword(composed, "md5$abc")).toBe(false)
  })
})
