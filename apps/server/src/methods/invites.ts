import { issueToken } from "../api/auth"
import { method } from "../api/context"
import { sha256Hex } from "../api/crypto"
import { isEmail, normalizeEmail } from "../api/email-address"
import { CampflareError, invalidArguments } from "../api/errors"
import { nowSeconds, randomId } from "../api/ids"
import { userJson } from "../api/shapes"
import { clientAddress } from "../auth/throttle"
import { all, first, run, stmt } from "../db/query"
import { emailSender } from "../email"
import {
  acceptInvite,
  completeReset,
  createReset,
  INVITE_MAX_TTL,
  INVITER_ACTIVE,
  INVITE_MAX_USES,
  INVITE_TTL,
  inviteJson,
  inviteUrl,
  newCode,
  requestReset,
  RESET_MAX_TTL,
  RESET_MIN_TTL,
  RESET_TTL,
  resetUrl,
  ttlArg,
  type InviteRow,
} from "../invites"
import { activePerson, requireAdmin, requireOutranks, requireOwner } from "../api/roles"

// Invitations and password resets as links (docs/invites.md). Making them is
// an admin's (admin.invites:*, admin.users:write, plus the role); using them
// takes no token: the link's code is the credential, and the sign-in
// throttle bounds guessing at it.

const optionalInt = (value: string | undefined, name: string) => {
  if (value === undefined) return undefined
  const n = Number(value)
  if (!Number.isInteger(n)) throw invalidArguments(`${name} must be an integer`)
  return n
}

/** An invitation link: to one email, or open to `max_uses` people; as a member or (owners only) an admin. */
method("campflare.invites.create", "user", async (ctx) => {
  requireAdmin(ctx)
  const role = ctx.args.str("role") ?? "member"
  if (role !== "member" && role !== "admin") throw invalidArguments("role is member or admin")
  // Making an admin is granting a role: owners only, as in campflare.users.create.
  if (role === "admin") requireOwner(ctx)
  const given = ctx.args.str("email")
  const email = given === undefined ? undefined : normalizeEmail(given)
  if (email !== undefined && !isEmail(email)) throw new CampflareError("invalid_email")
  const ttl = ttlArg(optionalInt(ctx.args.str("expires_in"), "expires_in"), INVITE_TTL, 60, INVITE_MAX_TTL)
  const maxUses = optionalInt(ctx.args.str("max_uses"), "max_uses") ?? 1
  if (maxUses < 1 || maxUses > INVITE_MAX_USES) throw invalidArguments(`max_uses is between 1 and ${INVITE_MAX_USES}`)
  if (email !== undefined && maxUses !== 1) throw invalidArguments("an invite bound to an email is for one person")
  const asked = [...new Set(ctx.args.list("channels"))]
  const teamId = ctx.auth.team.id
  // The channels must be ones the inviter could bring someone into: public, or private and theirs.
  const [channels, taken] = await ctx.env.DB.batch([
    stmt(
      ctx.env.DB,
      `SELECT c.id FROM conversations c WHERE c.id IN (SELECT value FROM json_each(?1)) AND c.team_id = ?2
         AND c.kind = 'channel' AND c.is_archived = 0
         AND (c.is_private = 0 OR EXISTS (SELECT 1 FROM members m WHERE m.conversation_id = c.id AND m.user_id = ?3))`,
      JSON.stringify(asked),
      teamId,
      ctx.auth.user.id,
    ),
    stmt(ctx.env.DB, "SELECT 1 FROM users WHERE team_id = ? AND email = ?", teamId, email ?? null),
  ])
  const found = new Set((channels!.results as { id: string }[]).map((c) => c.id))
  const missing = asked.filter((c) => !found.has(c))
  if (missing.length) throw new CampflareError("channel_not_found", { channels: missing })
  if (taken!.results.length) throw new CampflareError("already_in_team")

  const code = newCode()
  const now = nowSeconds()
  const invite: InviteRow = {
    id: randomId("I"),
    team_id: teamId,
    hash: await sha256Hex(code),
    inviter: ctx.auth.user.id,
    email: email ?? null,
    role,
    channels: JSON.stringify(asked),
    max_uses: maxUses,
    uses: 0,
    expires: now + ttl,
    revoked: 0,
    created: now,
  }
  await run(
    ctx.env.DB,
    `INSERT INTO invites (id, team_id, hash, inviter, email, role, channels, max_uses, uses, expires, revoked, created)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, 0, ?)`,
    invite.id,
    invite.team_id,
    invite.hash,
    invite.inviter,
    invite.email,
    invite.role,
    invite.channels,
    invite.max_uses,
    invite.expires,
    invite.created,
  )
  const url = inviteUrl(ctx.origin, code)
  // With an email sender, an invite to an address is mailed too, after the answer: a failed send
  // must not lose the URL, which is shown only now. `emailed` says a send was started.
  const sender = emailSender(ctx.env)
  const emailed = Boolean(sender && invite.email)
  if (sender && invite.email) {
    const who = ctx.auth.user.real_name || ctx.auth.user.name
    ctx.waitUntil(
      sender
        .send({
          to: invite.email,
          subject: `${who} invited you to ${ctx.auth.team.name} on Campflare`,
          text:
            `${who} invited you to join ${ctx.auth.team.name} on Campflare.\n\n` +
            `Pick your name and password here:\n${url}\n\nThe link works until ${new Date(invite.expires * 1000).toUTCString()}.\n`,
        })
        .catch((error: unknown) => console.error("invite email failed", error)),
    )
  }
  return { invite: inviteJson(invite), url, emailed }
})

/** The workspace's invitations, newest first, each with its state. */
method("campflare.invites.list", "user", async (ctx) => {
  requireAdmin(ctx)
  const rows = await all<InviteRow & { inviter_name: string }>(
    ctx.env.DB,
    `SELECT i.*, u.name AS inviter_name, ${INVITER_ACTIVE} AS inviter_active
     FROM invites i JOIN users u ON u.id = i.inviter
     WHERE i.team_id = ? ORDER BY i.created DESC, i.id LIMIT ?`,
    ctx.auth.team.id,
    ctx.args.int("limit", 100, { min: 1, max: 1000 }),
  )
  return { invites: rows.map(inviteJson) }
})

/** Stops an invitation at once. Any admin may: revoking only takes power away. */
method("campflare.invites.revoke", "user", async (ctx) => {
  requireAdmin(ctx)
  const invite = await first<InviteRow>(
    ctx.env.DB,
    "UPDATE invites SET revoked = 1 WHERE id = ? AND team_id = ? RETURNING *",
    ctx.args.req("invite", "invite_not_found"),
    ctx.auth.team.id,
  )
  if (!invite) throw new CampflareError("invite_not_found")
  return { invite: inviteJson(invite) }
})

/**
 * Joins a workspace through an invitation, without a token: the code (or the
 * whole URL) is the credential. Answers the new person and their first token,
 * the `full` preset, as their own sign-in gets.
 */
method("campflare.invites.accept", "none", async (ctx) => {
  const user = await acceptInvite(ctx, {
    code: codeOf(ctx.args.req("code"), "join"),
    name: ctx.args.req("name"),
    realName: ctx.args.str("real_name"),
    email: ctx.args.str("email"),
    password: ctx.args.req("password"),
    ip: clientAddress(ctx.request.headers),
  })
  const token = await issueToken(ctx.env, {
    teamId: user.team_id,
    kind: "user",
    userId: user.id,
    scopes: ["full"],
    label: "invite",
  })
  return { user: userJson(user, ctx.origin), team_id: user.team_id, token }
})

/** A code, from itself or from the link it is in (…/join/<code>, …/reset/<code>). */
function codeOf(value: string, path: "join" | "reset"): string {
  const match = new RegExp(`/${path}/([^/?#]+)`).exec(value)
  return match ? match[1]! : value.trim()
}

/**
 * A password reset link for someone you outrank (an admin's for a member, an
 * owner's for an admin). Single use; replaces any earlier link of theirs.
 */
method("campflare.users.createPasswordReset", "user", async (ctx) => {
  requireAdmin(ctx)
  const target = await activePerson(ctx, ctx.args.req("user", "user_not_found"))
  requireOutranks(ctx, target)
  if (!target.email) throw new CampflareError("email_required")
  const ttl = ttlArg(optionalInt(ctx.args.str("expires_in"), "expires_in"), RESET_TTL, RESET_MIN_TTL, RESET_MAX_TTL)
  const { code, expires } = await createReset(ctx.env, {
    teamId: ctx.auth.team.id,
    userId: target.id,
    createdBy: ctx.auth.user.id,
    ttl,
  })
  return { url: resetUrl(ctx.origin, code), user_id: target.id, expires }
})

/** Sets a new password through a reset link, without a token. */
method("campflare.users.resetPassword", "none", async (ctx) => {
  const person = await completeReset(ctx.env, {
    code: codeOf(ctx.args.req("code"), "reset"),
    password: ctx.args.req("password"),
    ip: clientAddress(ctx.request.headers),
  })
  return { user_id: person.id, team_id: person.team_id }
})

/** Mails a reset link to whoever has this email, when this server can send email. */
method("campflare.users.requestPasswordReset", "none", async (ctx) => {
  await requestReset(ctx, {
    email: ctx.args.req("email"),
    workspace: ctx.args.str("workspace"),
    ip: clientAddress(ctx.request.headers),
  })
  return {}
})
