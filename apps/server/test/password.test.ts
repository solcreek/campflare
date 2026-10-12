import { SELF } from "cloudflare:test"
import { env } from "cloudflare:workers"
import { describe, expect, it } from "vitest"
import { hashPassword, verifyPassword } from "../src/auth/password"
import { waitMessage } from "../src/auth/routes"
import {
  BACKOFF_BASE,
  EMAIL_CEILING,
  IP_FREE_FAILURES,
  keys,
  PAIR_FREE_FAILURES,
  RATE_LIMIT,
} from "../src/auth/throttle"
import { browser } from "./browser"
import { call, expectError, ORIGIN, ok, workspace } from "./helpers"

let n = 0
/** A client address no other request uses (documentation ranges), so throttling is each test's own. */
const freshIp = () => `2001:db8::${(++n).toString(16)}`

const signIn = (body: Record<string, string>, ip = freshIp()) =>
  SELF.fetch(`${ORIGIN}/auth/sign-in/campflare-password`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: ORIGIN, "cf-connecting-ip": ip },
    body: JSON.stringify(body),
  })

async function signInAnswer(body: Record<string, string>, ip?: string) {
  const res = await signIn(body, ip)
  return {
    status: res.status,
    retryAfter: Number(res.headers.get("retry-after")),
    body: (await res.json()) as { message?: string; campflare_user?: string; team?: string },
  }
}

const postLogin = (form: Record<string, string>, ip = freshIp()) =>
  browser().go("/login", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", "cf-connecting-ip": ip },
    body: new URLSearchParams(form),
  })

const throttleRow = (key: string) =>
  env.DB.prepare("SELECT count, blocked_until, expires FROM sign_in_throttle WHERE key = ?")
    .bind(key)
    .first<{ count: number; blocked_until: number; expires: number }>()

/** Lets a waiting counter go now, as if its wait had passed. */
const endWait = (key: string) =>
  env.DB.prepare("UPDATE sign_in_throttle SET blocked_until = 0 WHERE key = ?").bind(key).run()

const now = () => Math.floor(Date.now() / 1000)

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

  it("shows the workspace question and errors on the sign-in page", async () => {
    const email = uniqueEmail("ines")
    for (const w of [await workspace(), await workspace()]) {
      const ines = await w.addUser("ines", { email })
      await ok("campflare.users.setPassword", { password: "Inès aime le café" }, ines.token)
    }
    const post = (form: Record<string, string>) => postLogin(form)
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

describe("throttling sign-in", () => {
  async function person(name: string, password: string) {
    const w = await workspace()
    const email = uniqueEmail(name)
    const user = await w.addUser(name, { email })
    await ok("campflare.users.setPassword", { password }, user.token)
    return { ...user, email, password }
  }

  it("slows the address that guesses, never the person signing in from elsewhere", async () => {
    const wei = await person("wei", "长城不是一天建成的哦")
    const attacker = freshIp()
    for (let i = 0; i < PAIR_FREE_FAILURES; i++) {
      expect((await signInAnswer({ email: wei.email, password: `猜错了第${i}次啊啊啊` }, attacker)).status).toBe(401)
    }
    // The address that guessed waits, even with the right password, and is told how long.
    const blocked = await signInAnswer({ email: wei.email, password: wei.password }, attacker)
    expect(blocked).toMatchObject({ status: 429, body: { message: "too_many_attempts" } })
    expect(blocked.retryAfter).toBeGreaterThan(0)
    expect(blocked.retryAfter).toBeLessThanOrEqual(BACKOFF_BASE)
    // Wei, anywhere else, signs in.
    expect((await signInAnswer({ email: wei.email, password: wei.password })).body.campflare_user).toBe(wei.id)
    // A right password from an address clears that address's wrong ones for the email.
    await endWait(keys.pair(wei.email, attacker))
    expect((await signInAnswer({ email: wei.email, password: wei.password }, attacker)).status).toBe(200)
    expect(await throttleRow(keys.pair(wei.email, attacker))).toBeNull()
  })

  it("doubles the wait with each further wrong password", async () => {
    const pierre = await person("pierre", "Pierre a vu l'été")
    const ip = freshIp()
    const pair = keys.pair(pierre.email, ip)
    for (let i = 0; i < PAIR_FREE_FAILURES; i++) await signIn({ email: pierre.email, password: `Faux n°${i}` }, ip)
    expect((await signInAnswer({ email: pierre.email, password: "Faux encore" }, ip)).retryAfter).toBeGreaterThan(
      BACKOFF_BASE / 2,
    )
    await endWait(pair)
    expect((await signInAnswer({ email: pierre.email, password: "Faux encore" }, ip)).status).toBe(401)
    const second = await signInAnswer({ email: pierre.email, password: pierre.password }, ip)
    expect(second.status).toBe(429)
    expect(second.retryAfter).toBeGreaterThan(BACKOFF_BASE)
    expect(second.retryAfter).toBeLessThanOrEqual(2 * BACKOFF_BASE)
  })

  it("throttles an unknown email the same way, so a wait says nothing about who has a password", async () => {
    const ip = freshIp()
    const email = uniqueEmail("niemand")
    for (let i = 0; i < PAIR_FREE_FAILURES; i++) {
      expect((await signInAnswer({ email, password: `Größe ${i}` }, ip)).status).toBe(401)
    }
    expect((await signInAnswer({ email, password: "Größe" }, ip)).status).toBe(429)
  })

  it("slows one address trying many emails", async () => {
    const ip = freshIp()
    for (let i = 0; i < IP_FREE_FAILURES; i++) {
      expect((await signInAnswer({ email: uniqueEmail("spray"), password: `스프레이 ${i}` }, ip)).status).toBe(401)
    }
    const hyun = await person("hyun", "현이의 비밀번호예요")
    const blocked = await signInAnswer({ email: hyun.email, password: hyun.password }, ip)
    expect(blocked).toMatchObject({ status: 429, body: { message: "too_many_attempts" } })
    expect((await signInAnswer({ email: hyun.email, password: hyun.password })).status).toBe(200)
  })

  it("past the email's ceiling, gives each address one wrong try, and still lets the person in", async () => {
    const yuki = await person("yuki", "雪の降る夜に会いましょう")
    // Many addresses guessed already.
    await env.DB.prepare("INSERT INTO sign_in_throttle (key, count, blocked_until, expires) VALUES (?, ?, 0, ?)")
      .bind(keys.email(yuki.email), EMAIL_CEILING, now() + 3600)
      .run()
    const guesser = freshIp()
    expect((await signInAnswer({ email: yuki.email, password: "違うパスワードです" }, guesser)).status).toBe(401)
    expect((await signInAnswer({ email: yuki.email, password: yuki.password }, guesser)).status).toBe(429)
    // The ceiling only slows: Yuki, from an address that hasn't guessed, signs in at the first try.
    expect((await signInAnswer({ email: yuki.email, password: yuki.password })).status).toBe(200)
    expect((await throttleRow(keys.email(yuki.email)))!.count).toBe(EMAIL_CEILING + 1)
  })

  it("caps attempts a minute from one address, right ones too, on both ways in", async () => {
    const lucia = await person("lucia", "Lucía baila flamenco")
    const ip = freshIp()
    for (let i = 0; i < RATE_LIMIT; i++) {
      expect((await signInAnswer({ email: lucia.email, password: lucia.password }, ip)).status).toBe(200)
    }
    const capped = await signInAnswer({ email: lucia.email, password: lucia.password }, ip)
    expect(capped.status).toBe(429)
    expect(capped.retryAfter).toBeLessThanOrEqual(60)
    const byToken = await SELF.fetch(`${ORIGIN}/auth/sign-in/campflare-token`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: ORIGIN, "cf-connecting-ip": ip },
      body: JSON.stringify({ token: lucia.token }),
    })
    expect(byToken.status).toBe(429)
    expect(byToken.headers.get("retry-after")).toMatch(/^\d+$/)
  })

  it("counts wrong tokens against the address", async () => {
    const ip = freshIp()
    const tryToken = (token: string) =>
      SELF.fetch(`${ORIGIN}/auth/sign-in/campflare-token`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: ORIGIN, "cf-connecting-ip": ip },
        body: JSON.stringify({ token }),
      })
    expect((await tryToken("xoxp-not-a-token")).status).toBe(401)
    const w = await workspace()
    const app = await w.addApp("Robot")
    expect((await tryToken(app.botToken)).status).toBe(401)
    expect((await throttleRow(keys.ip(ip)))!.count).toBe(2)
  })

  it("tells the person on the sign-in page how long to wait, with a 429", async () => {
    const amelie = await person("amelie", "Amélie mange des crêpes")
    const ip = freshIp()
    for (let i = 0; i < PAIR_FREE_FAILURES; i++) await signIn({ email: amelie.email, password: `Crêpe n°${i}` }, ip)
    const page = await postLogin({ email: amelie.email, password: amelie.password }, ip)
    expect(page.status).toBe(429)
    expect(Number(page.headers.get("retry-after"))).toBeGreaterThan(0)
    const html = await page.text()
    expect(html).toMatch(/Too many sign-in attempts from your network\. Wait \d+ seconds?, then try again\./)
    expect(html).not.toContain("<script")
    expect(html).toContain(`value="${amelie.email}"`)
    // The token form says the same.
    const tokenPage = await postLogin({ token: amelie.token }, ip)
    expect(tokenPage.status).toBe(200) // a token from a throttled address for a password is fine...
  })

  it("words the wait in seconds or whole minutes", () => {
    expect(waitMessage(1)).toContain("Wait 1 second,")
    expect(waitMessage(45)).toContain("Wait 45 seconds,")
    expect(waitMessage(60)).toContain("Wait 1 minute,")
    expect(waitMessage(61)).toContain("Wait 2 minutes,")
  })

  it("prunes expired counters as attempts come in", async () => {
    const stale = Array.from({ length: 3 }, (_, i) => `ip:stale-${n}-${i}`)
    for (const key of stale) {
      await env.DB.prepare("INSERT INTO sign_in_throttle (key, count, blocked_until, expires) VALUES (?, 9, 0, ?)")
        .bind(key, now() - 10)
        .run()
    }
    await signInAnswer({ email: uniqueEmail("prune"), password: "Ça ne marche pas" })
    for (const key of stale) expect(await throttleRow(key)).toBeNull()
  })
})

describe("changing a password", () => {
  it("ends the person's browser sign-ins and lifts the waits, but keeps their tokens", async () => {
    const w = await workspace()
    const email = uniqueEmail("zhang")
    const zhang = await w.addUser("zhang", { email })
    await ok("campflare.users.setPassword", { password: "第一个密码真的很长很长" }, zhang.token)
    // Two browser sessions, and an address that guessed.
    expect((await signIn({ email, password: "第一个密码真的很长很长" })).status).toBe(200)
    expect((await signIn({ email, password: "第一个密码真的很长很长" })).status).toBe(200)
    const ip = freshIp()
    for (let i = 0; i < PAIR_FREE_FAILURES; i++) await signIn({ email, password: `错误的密码${i}号` }, ip)
    const sessions = () =>
      env.DB.prepare(
        `SELECT count(*) AS n FROM "session" WHERE "userId" IN
           (SELECT "userId" FROM "account" WHERE "providerId" = 'campflare' AND "accountId" = ?)`,
      )
        .bind(zhang.id)
        .first<{ n: number }>()
    expect((await sessions())!.n).toBe(2)

    await ok("campflare.users.setPassword", { password: "第二个密码也真的很长呢" }, zhang.token)
    expect((await sessions())!.n).toBe(0)
    expect(await throttleRow(keys.pair(email, ip))).toBeNull()
    // The token that set it (an app install) still works.
    await ok("auth.test", {}, zhang.token)
    expect((await signInAnswer({ email, password: "第二个密码也真的很长呢" }, ip)).status).toBe(200)
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
