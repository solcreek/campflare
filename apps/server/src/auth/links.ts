import type { Context, Hono, MiddlewareHandler } from "hono"
import { CampflareError } from "../api/errors"
import { publicOrigin } from "../api/origin"
import { emailSender } from "../email"
import type { Env } from "../env"
import {
  acceptInvite,
  completeReset,
  findInvite,
  findReset,
  inviteState,
  requestReset,
  type InviteDetails,
  type ResetDetails,
} from "../invites"
import { escape, page } from "./pages"
import { authFor, waitMessage } from "./routes"
import { clientAddress } from "./throttle"

// The pages behind invitation and reset links (docs/invites.md): script-free
// forms like /login's, acting through the same functions as the API methods.

type C = Context<{ Bindings: Env }>

const linkContext = (c: C) => ({
  env: c.env,
  origin: publicOrigin(c.req.raw),
  waitUntil: (p: Promise<unknown>) => c.executionCtx.waitUntil(p),
})

/** A CampflareError's code and its first message (Slack's response_metadata), if any. */
function problem(error: unknown): { code: string; message?: string; retryAfter?: number } {
  if (!(error instanceof CampflareError)) throw error
  const extra = error.extra as { response_metadata?: { messages?: string[] }; retry_after?: number }
  const message = extra.response_metadata?.messages?.[0]?.replace(/^\[ERROR\] /, "")
  return { code: error.code, message, retryAfter: extra.retry_after }
}

const passwordProblem = (message: string | undefined) =>
  message ? `${message[0]!.toUpperCase()}${message.slice(1)}.` : "That password won't do."

const DEAD_INVITE: Record<string, string> = {
  invite_expired: "This invitation has expired.",
  invite_used_up: "This invitation has been used as many times as it allows.",
  invite_revoked: "This invitation was withdrawn.",
  invalid_invite: "This invitation link doesn't work.",
}

function deadInvite(url: URL, code: string): Response {
  return page(
    "Invitation",
    `<h1>Can't join with this link</h1>
<p>${DEAD_INVITE[code] ?? DEAD_INVITE.invalid_invite!} Ask whoever sent it for a new one.</p>`,
    url,
    { status: code === "invalid_invite" ? 404 : 410 },
  )
}

const JOIN_ERRORS: Record<string, string> = {
  email_mismatch: "This invitation is for another email address.",
  email_required: "Enter your email address: you sign in with it.",
  invalid_email: "That doesn't look like an email address.",
  invalid_name:
    "A handle is up to 80 lower-case letters, digits, dots, dashes and underscores, starting with a letter or digit.",
  already_in_team:
    "That email already has an account in this workspace. Sign in instead, or ask an admin for a password reset link.",
  passwords_differ: "The two passwords differ.",
}

export interface JoinForm {
  name?: string
  real_name?: string
  email?: string
  error?: string
  retryAfter?: number
}

export function joinPage(url: URL, invite: InviteDetails, appUrl: string | undefined, form: JoinForm = {}): Response {
  const role = invite.role === "admin" ? " as an admin" : ""
  return page(
    `Join ${invite.team_name}`,
    `<h1>Join ${escape(invite.team_name)}</h1>
<p>${escape(invite.inviter_name)} invited you to ${escape(invite.team_name)} on Campflare${role}.</p>
${form.error ? `<p role="alert"><strong>${escape(form.error)}</strong></p>` : ""}
<form method="post" action="${escape(url.pathname)}">
  ${
    invite.email
      ? `<p>You'll sign in as <strong>${escape(invite.email)}</strong>.</p>`
      : `<label for="email">Email</label>
  <input id="email" name="email" type="email" autocomplete="email" required value="${escape(form.email ?? "")}">`
  }
  <label for="name">Handle</label>
  <input id="name" name="name" type="text" autocomplete="username" required pattern="@?[A-Za-z0-9][A-Za-z0-9._\\-]{0,79}" placeholder="what @mentions call you" value="${escape(form.name ?? "")}">
  <label for="real_name">Full name</label>
  <input id="real_name" name="real_name" type="text" autocomplete="name" value="${escape(form.real_name ?? "")}">
  <label for="password">Password</label>
  <input id="password" name="password" type="password" autocomplete="new-password" required minlength="10">
  <label for="password_again">Password, again</label>
  <input id="password_again" name="password_again" type="password" autocomplete="new-password" required minlength="10">
  <div class="row"><button class="primary" type="submit">Join</button></div>
</form>`,
    url,
    {
      ...(form.retryAfter ? { status: 429, retryAfter: form.retryAfter } : form.error ? { status: 400 } : {}),
      // The POST answers with a redirect to the app, and browsers hold that to form-action too.
      formActions: appUrl ? [appUrl] : [],
    },
  )
}

/** After joining: signed in; the app is the next stop, or the CLI when there's no app to go to. */
export function joinedPage(
  url: URL,
  where: { origin: string; team: string; appUrl?: string },
  handle: string,
  headers?: Headers,
) {
  const { origin, team, appUrl } = where
  return page(
    "Welcome",
    `<h1>Welcome to ${escape(team)}</h1>
<p>You're <strong>@${escape(handle)}</strong>. Sign in anywhere with your email and password.</p>
${appUrl ? `<div class="row"><a class="button primary" href="${escape(appUrl)}">Open Campflare</a></div>` : ""}
<p>From a terminal: <code>campflare login --url ${escape(origin)} --oauth</code></p>`,
    url,
    { headers },
  )
}

function resetPage(url: URL, person: ResetDetails, error?: string, retryAfter?: number): Response {
  return page(
    "New password",
    `<h1>Choose a new password</h1>
<p>For <strong>@${escape(person.name)}</strong> in ${escape(person.team_name)}. Setting it signs you out of your browsers and connected apps.</p>
${error ? `<p role="alert"><strong>${escape(error)}</strong></p>` : ""}
<form method="post" action="${escape(url.pathname)}">
  <label for="password">New password</label>
  <input id="password" name="password" type="password" autocomplete="new-password" required minlength="10">
  <label for="password_again">Again</label>
  <input id="password_again" name="password_again" type="password" autocomplete="new-password" required minlength="10">
  <div class="row"><button class="primary" type="submit">Set password</button></div>
</form>`,
    url,
    retryAfter ? { status: 429, retryAfter } : error ? { status: 400 } : {},
  )
}

const deadReset = (url: URL) =>
  page(
    "Password reset",
    `<h1>This reset link doesn't work</h1>
<p>It was used already, it expired, or it was replaced by a newer one. Ask an admin for a new link, or ask for one by email at <a href="/reset">/reset</a> if this server sends email.</p>`,
    url,
    { status: 404 },
  )

function requestPage(url: URL, canSend: boolean, state: { error?: string; sent?: boolean; retryAfter?: number } = {}) {
  if (!canSend) {
    return page(
      "Password reset",
      `<h1>Forgot your password?</h1>
<p>This server doesn't send email, so ask an admin of your workspace for a reset link. They make one with <code>campflare admin reset-password @you</code>.</p>`,
      url,
    )
  }
  if (state.sent) {
    return page(
      "Password reset",
      `<h1>Check your email</h1>
<p>If an account has that address, a link to set a new password is on its way. It works for an hour.</p>`,
      url,
    )
  }
  return page(
    "Password reset",
    `<h1>Forgot your password?</h1>
<p>We'll email you a link to set a new one.</p>
${state.error ? `<p role="alert"><strong>${escape(state.error)}</strong></p>` : ""}
<form method="post" action="/reset">
  <label for="email">Email</label>
  <input id="email" name="email" type="email" autocomplete="email" required>
  <label for="workspace">Workspace <span>(optional)</span></label>
  <input id="workspace" name="workspace" type="text" autocomplete="off" placeholder="its domain or name">
  <div class="row"><button class="primary" type="submit">Email me a link</button></div>
</form>`,
    url,
    state.retryAfter ? { status: 429, retryAfter: state.retryAfter } : state.error ? { status: 400 } : {},
  )
}

async function formOf(c: C) {
  const form = await c.req.formData()
  return (name: string) => String(form.get(name) ?? "")
}

/**
 * Whether a form POST came from another site. These forms sign a person in or
 * change a password, so a page elsewhere posting them would be login CSRF (its
 * own account's session in the victim's browser). As Better Auth's origin
 * check: an Origin must be this server's; without one, Sec-Fetch-Site must be
 * same-origin. Browsers send at least one on every form POST; a request with
 * neither isn't a browser's, and carries no one's cookies to abuse.
 */
export function crossSite(request: Request): boolean {
  const origin = request.headers.get("origin")
  if (origin !== null) return origin !== publicOrigin(request) && origin !== new URL(request.url).origin
  const site = request.headers.get("sec-fetch-site")
  return site !== null && site !== "same-origin"
}

const sameSite: MiddlewareHandler<{ Bindings: Env }> = async (c, next) => {
  if (crossSite(c.req.raw)) {
    return page(
      "Not allowed",
      `<h1>This form can only be sent from this site</h1>
<p>Open the link again and fill in the form here.</p>`,
      new URL(c.req.url),
      { status: 403 },
    )
  }
  await next()
}

export function mountLinks(app: Hono<{ Bindings: Env }>) {
  app.get("/join/:code", async (c) => {
    const url = new URL(c.req.url)
    const invite = await findInvite(c.env, c.req.param("code"))
    if (!invite) return deadInvite(url, "invalid_invite")
    const state = inviteState(invite)
    if (state !== "pending") return deadInvite(url, `invite_${state}`)
    return joinPage(url, invite, c.env.APP_URL)
  })

  app.post("/join/:code", sameSite, async (c) => {
    const url = new URL(c.req.url)
    const code = c.req.param("code")
    const field = await formOf(c)
    const form = { name: field("name"), real_name: field("real_name"), email: field("email") }
    const invite = await findInvite(c.env, code)
    if (!invite) return deadInvite(url, "invalid_invite")
    if (field("password") !== field("password_again")) {
      return joinPage(url, invite, c.env.APP_URL, { ...form, error: JOIN_ERRORS.passwords_differ })
    }
    let user
    try {
      user = await acceptInvite(linkContext(c), {
        code,
        name: form.name,
        realName: form.real_name,
        email: form.email,
        password: field("password"),
        ip: clientAddress(c.req.raw.headers),
      })
    } catch (error) {
      const { code: reason, message, retryAfter } = problem(error)
      if (reason in DEAD_INVITE) return deadInvite(url, reason)
      if (reason === "too_many_attempts") {
        return joinPage(url, invite, c.env.APP_URL, { ...form, error: waitMessage(retryAfter!), retryAfter })
      }
      const text =
        reason === "invalid_password"
          ? passwordProblem(message)
          : reason === "name_taken"
            ? `@${form.name.replace(/^@/, "").toLowerCase()} is taken in this workspace. Pick another handle.`
            : (JOIN_ERRORS[reason] ?? `That didn't work (${reason}).`)
      return joinPage(url, invite, c.env.APP_URL, { ...form, error: text })
    }
    // Signed in, as /login signs in: OAuth clients (the app, the CLI) find the session and skip the password.
    const signedIn = await authFor(c.env, c.req.raw).api.signInCampflareUser({
      body: { user_id: user.id },
      headers: c.req.raw.headers,
      asResponse: true,
    })
    const headers = new Headers()
    for (const cookie of signedIn.headers.getSetCookie()) headers.append("set-cookie", cookie)
    const appUrl = c.env.APP_URL
    if (appUrl) {
      headers.set("location", appUrl)
      return new Response(null, { status: 302, headers })
    }
    return joinedPage(url, { origin: publicOrigin(c.req.raw), team: invite.team_name }, user.name, headers)
  })

  app.get("/reset/:code", async (c) => {
    const url = new URL(c.req.url)
    const person = await findReset(c.env, c.req.param("code"))
    return person ? resetPage(url, person) : deadReset(url)
  })

  app.post("/reset/:code", sameSite, async (c) => {
    const url = new URL(c.req.url)
    const code = c.req.param("code")
    const field = await formOf(c)
    const person = await findReset(c.env, code)
    if (!person) return deadReset(url)
    if (field("password") !== field("password_again")) return resetPage(url, person, JOIN_ERRORS.passwords_differ)
    try {
      await completeReset(c.env, { code, password: field("password"), ip: clientAddress(c.req.raw.headers) })
    } catch (error) {
      const { code: reason, message, retryAfter } = problem(error)
      if (reason === "too_many_attempts") return resetPage(url, person, waitMessage(retryAfter!), retryAfter)
      if (reason === "invalid_password") return resetPage(url, person, passwordProblem(message))
      return deadReset(url)
    }
    const appUrl = c.env.APP_URL
    return page(
      "Password changed",
      `<h1>Password changed</h1>
<p>Sign in as <strong>@${escape(person.name)}</strong> with your email and the new password.</p>
${appUrl ? `<div class="row"><a class="button primary" href="${escape(appUrl)}">Open Campflare</a></div>` : ""}`,
      url,
    )
  })

  app.get("/reset", (c) => requestPage(new URL(c.req.url), emailSender(c.env) !== undefined))

  app.post("/reset", sameSite, async (c) => {
    const url = new URL(c.req.url)
    if (!emailSender(c.env)) return requestPage(url, false)
    const field = await formOf(c)
    try {
      await requestReset(linkContext(c), {
        email: field("email"),
        workspace: field("workspace") || undefined,
        ip: clientAddress(c.req.raw.headers),
      })
    } catch (error) {
      const { code: reason, retryAfter } = problem(error)
      if (reason === "too_many_attempts") {
        return requestPage(url, true, { error: waitMessage(retryAfter!), retryAfter })
      }
      return requestPage(url, true, { error: JOIN_ERRORS.invalid_email })
    }
    return requestPage(url, true, { sent: true })
  })
}
