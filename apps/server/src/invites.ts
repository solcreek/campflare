import { sha256Hex } from "./api/crypto"
import { isEmail, normalizeEmail } from "./api/email-address"
import { CampflareError, invalidArguments } from "./api/errors"
import { ids, nowSeconds, randomSecret } from "./api/ids"
import { userJson } from "./api/shapes"
import { checkPassword, hashPassword, setPassword } from "./auth/password"
import { addressChecks, counter, countFailure, IP_FREE_FAILURES, keys, readCounter, waitFor } from "./auth/throttle"
import { first, isUniqueViolation, run, stmt } from "./db/query"
import type { UserRow } from "./db/rows"
import { emailSender } from "./email"
import type { Env } from "./env"
import { channelType, publish } from "./events"
import { HANDLE } from "./api/roles"

// Invitations and password resets: links whose code is shown once and stored
// as a SHA-256 (migration 0020, docs/invites.md). The API methods
// (src/methods/invites.ts) and the pages (src/auth/links.ts) both act through
// the functions here, so the checks are one set.

export const INVITE_TTL = 7 * 86_400
export const INVITE_MAX_TTL = 30 * 86_400
export const INVITE_MAX_USES = 1000
export const RESET_TTL = 3600
export const RESET_MIN_TTL = 300
export const RESET_MAX_TTL = 86_400
/** Reset emails asked for one address before each further one waits. */
export const RESET_FREE_REQUESTS = 3

/** What acting on a link needs: the Worker's bindings, somewhere to finish work, and the public origin. */
export interface LinkContext {
  env: Env
  origin: string
  waitUntil(promise: Promise<unknown>): void
}

/** A link's secret part: 32 random bytes, hex. */
export const newCode = () => randomSecret(32)
const CODE = /^[0-9a-f]{64}$/

export const inviteUrl = (origin: string, code: string) => `${origin}/join/${code}`
export const resetUrl = (origin: string, code: string) => `${origin}/reset/${code}`

export interface InviteRow {
  id: string
  team_id: string
  hash: string
  inviter: string
  email: string | null
  role: "member" | "admin"
  channels: string
  max_uses: number
  uses: number
  expires: number
  revoked: number
  created: number
}

export type InviteState = "pending" | "used_up" | "expired" | "revoked"

export function inviteState(invite: Pick<InviteRow, "revoked" | "expires" | "uses" | "max_uses">, now = nowSeconds()) {
  if (invite.revoked) return "revoked"
  if (invite.uses >= invite.max_uses) return "used_up"
  if (invite.expires <= now) return "expired"
  return "pending"
}

const STATE_ERRORS: Record<InviteState, string> = {
  pending: "invalid_invite",
  used_up: "invite_used_up",
  expired: "invite_expired",
  revoked: "invite_revoked",
}

/** An invite as the API answers it. */
export function inviteJson(invite: InviteRow & { inviter_name?: string }) {
  return {
    id: invite.id,
    email: invite.email,
    role: invite.role,
    channels: JSON.parse(invite.channels) as string[],
    inviter: invite.inviter,
    ...(invite.inviter_name === undefined ? {} : { inviter_name: invite.inviter_name }),
    max_uses: invite.max_uses,
    uses: invite.uses,
    expires: invite.expires,
    created: invite.created,
    state: inviteState(invite),
  }
}

/** An invite with what its page shows: the workspace and who invited. */
export type InviteDetails = InviteRow & { team_name: string; inviter_name: string }

const INVITE_DETAILS = `SELECT i.*, t.name AS team_name, coalesce(nullif(u.real_name, ''), u.name) AS inviter_name
  FROM invites i JOIN teams t ON t.id = i.team_id JOIN users u ON u.id = i.inviter WHERE i.hash = ?`

/** The invite a code opens, whatever its state; undefined for a code that opens none. */
export async function findInvite(env: Env, code: string): Promise<InviteDetails | undefined> {
  if (!CODE.test(code)) return undefined
  return first<InviteDetails>(env.DB, INVITE_DETAILS, await sha256Hex(code))
}

const tooManyAttempts = (seconds: number) => new CampflareError("too_many_attempts", { retry_after: seconds })

export interface Joining {
  code: string
  /** The handle they pick. */
  name: string
  realName?: string
  /** Theirs; must be the invite's when it is bound to one. */
  email?: string
  password: string
  /** The client's address, for the sign-in throttle. */
  ip: string
}

/**
 * Admits a person through an invite: their user row, their password, #general
 * and the invite's channels, one use counted, all in one batch that changes
 * nothing unless the invite is still good and its inviter may still invite.
 * Publishes team_join, and member_joined_channel for each conversation joined.
 */
export async function acceptInvite(lc: LinkContext, joining: Joining): Promise<UserRow> {
  const { env } = lc
  const now = nowSeconds()
  const hash = await sha256Hex(joining.code)
  const results = await env.DB.batch([...addressChecks(env.DB, joining.ip, now), stmt(env.DB, INVITE_DETAILS, hash)])
  const wait = waitFor(results, now)
  if (wait !== undefined) throw tooManyAttempts(wait)
  const invite = results[3]!.results[0] as InviteDetails | undefined
  if (!invite) {
    await countFailure(env.DB, keys.ip(joining.ip), now, IP_FREE_FAILURES).run()
    throw new CampflareError("invalid_invite")
  }
  const state = inviteState(invite, now)
  if (state !== "pending") throw new CampflareError(STATE_ERRORS[state])

  const given = joining.email ? normalizeEmail(joining.email) : undefined
  if (invite.email && given && given !== invite.email) throw new CampflareError("email_mismatch")
  const email = invite.email ?? given
  if (!email) throw new CampflareError("email_required")
  if (!isEmail(email)) throw new CampflareError("invalid_email")
  const name = joining.name.trim().replace(/^@/, "").toLowerCase()
  if (!HANDLE.test(name)) throw new CampflareError("invalid_name")
  const passwordHash = await hashPassword(checkPassword(joining.password))

  const id = ids.user()
  const exists = "EXISTS (SELECT 1 FROM users WHERE id = ?)"
  let batch: D1Result[]
  try {
    batch = await env.DB.batch([
      // Only while the invite is good, and its inviter is still an active admin (an owner, for an admin invite).
      stmt(
        env.DB,
        `INSERT INTO users (id, team_id, name, real_name, display_name, email, is_admin, is_owner, is_bot, updated, created)
         SELECT ?1, i.team_id, ?2, ?3, '', ?4, CASE WHEN i.role = 'admin' THEN 1 ELSE 0 END, 0, 0, ?5, ?5
         FROM invites i WHERE i.id = ?6 AND i.revoked = 0 AND i.expires > ?5 AND i.uses < i.max_uses
           AND EXISTS (SELECT 1 FROM users a WHERE a.id = i.inviter AND a.deleted = 0 AND a.is_admin = 1
                       AND (i.role = 'member' OR a.is_owner = 1))`,
        id,
        name,
        joining.realName?.trim() ?? "",
        email,
        now,
        invite.id,
      ),
      stmt(env.DB, `UPDATE invites SET uses = uses + 1 WHERE id = ? AND ${exists}`, invite.id, id),
      stmt(
        env.DB,
        `INSERT INTO passwords (user_id, hash, updated) SELECT ?, ?, ? WHERE ${exists}`,
        id,
        passwordHash,
        now,
        id,
      ),
      // Everyone is in #general, as in Slack; then the invite's conversations that are still open.
      stmt(
        env.DB,
        `INSERT OR IGNORE INTO members (conversation_id, user_id, joined)
         SELECT c.id, ?1, ?2 FROM conversations c
         WHERE c.team_id = ?3 AND c.kind = 'channel' AND c.is_archived = 0
           AND (c.is_general = 1 OR c.id IN (SELECT value FROM json_each(?4)))
           AND EXISTS (SELECT 1 FROM users WHERE id = ?1)`,
        id,
        now,
        invite.team_id,
        invite.channels,
      ),
      stmt(env.DB, "SELECT * FROM users WHERE id = ?", id),
      // Who hears of each conversation joined: its members, the newcomer among them.
      stmt(
        env.DB,
        `SELECT c.id, c.kind, c.is_private,
           (SELECT json_group_array(m.user_id) FROM members m WHERE m.conversation_id = c.id) AS audience
         FROM conversations c JOIN members j ON j.conversation_id = c.id AND j.user_id = ?`,
        id,
      ),
    ])
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new CampflareError(String(error).includes("email") ? "already_in_team" : "name_taken")
    }
    throw error
  }
  const user = batch[4]!.results[0] as UserRow | undefined
  if (!user) {
    // Changed since it was read: say how, or that its inviter can't invite any more.
    const now2 = nowSeconds()
    const again = await first<InviteRow>(env.DB, "SELECT * FROM invites WHERE id = ?", invite.id)
    throw new CampflareError(STATE_ERRORS[inviteState(again!, now2)])
  }
  publish(lc, { teamId: user.team_id, audience: "team", event: { type: "team_join", user: userJson(user, lc.origin) } })
  const joined = batch[5]!.results as { id: string; kind: "channel"; is_private: number; audience: string }[]
  for (const c of joined) {
    publish(lc, {
      teamId: user.team_id,
      audience: JSON.parse(c.audience) as string[],
      event: {
        type: "member_joined_channel",
        user: user.id,
        channel: c.id,
        channel_type: channelType(c) === "channel" ? "C" : "G",
        team: user.team_id,
        inviter: invite.inviter,
      },
    })
  }
  return user
}

/** A new reset link for a person, replacing any earlier one of theirs. */
export async function createReset(
  env: Env,
  opts: { teamId: string; userId: string; createdBy: string | null; ttl: number },
): Promise<{ code: string; expires: number }> {
  const code = newCode()
  const now = nowSeconds()
  const expires = now + opts.ttl
  await env.DB.batch([
    stmt(env.DB, "DELETE FROM password_resets WHERE user_id = ?", opts.userId),
    stmt(
      env.DB,
      "INSERT INTO password_resets (hash, team_id, user_id, created_by, expires, created) VALUES (?, ?, ?, ?, ?, ?)",
      await sha256Hex(code),
      opts.teamId,
      opts.userId,
      opts.createdBy,
      expires,
      now,
    ),
  ])
  return { code, expires }
}

export type ResetDetails = Pick<UserRow, "id" | "name" | "email" | "team_id"> & { team_name: string }

const RESET_DETAILS = `SELECT u.id, u.name, u.email, u.team_id, t.name AS team_name
  FROM password_resets r JOIN users u ON u.id = r.user_id JOIN teams t ON t.id = r.team_id
  WHERE r.hash = ? AND r.expires > ? AND u.deleted = 0`

/** The person a reset code is for, while it is good; undefined otherwise. */
export async function findReset(env: Env, code: string): Promise<ResetDetails | undefined> {
  if (!CODE.test(code)) return undefined
  return first<ResetDetails>(env.DB, RESET_DETAILS, await sha256Hex(code), nowSeconds())
}

/**
 * Sets a new password through a reset link. A password Campflare refuses
 * leaves the link as it was; a good one spends it (and any other of the
 * person's), then goes through setPassword, which ends their sessions and grants.
 */
export async function completeReset(
  env: Env,
  opts: { code: string; password: string; ip: string },
): Promise<ResetDetails> {
  const now = nowSeconds()
  const hash = await sha256Hex(opts.code)
  const results = await env.DB.batch([...addressChecks(env.DB, opts.ip, now), stmt(env.DB, RESET_DETAILS, hash, now)])
  const wait = waitFor(results, now)
  if (wait !== undefined) throw tooManyAttempts(wait)
  const refuse = async () => {
    await countFailure(env.DB, keys.ip(opts.ip), now, IP_FREE_FAILURES).run()
    return new CampflareError("invalid_reset")
  }
  const person = results[3]!.results[0] as ResetDetails | undefined
  if (!person) throw await refuse()
  checkPassword(opts.password)
  // Single use: whoever deletes the row has it; two at once can't both.
  const claimed = await run(
    env.DB,
    "DELETE FROM password_resets WHERE user_id = (SELECT user_id FROM password_resets WHERE hash = ? AND expires > ?)",
    hash,
    now,
  )
  if (!claimed.meta.changes) throw await refuse()
  await setPassword(env, person, opts.password)
  return person
}

/**
 * Mails a reset link to each active person with this email (in this workspace,
 * if given). Without an email sender, email_not_configured; with one, it
 * answers the same whether or not the address has an account.
 */
export async function requestReset(lc: LinkContext, opts: { email: string; workspace?: string; ip: string }) {
  const { env } = lc
  const sender = emailSender(env)
  if (!sender) {
    throw new CampflareError("email_not_configured", {
      response_metadata: {
        messages: [
          "[ERROR] this server can't send email: ask an admin for a reset link (campflare admin reset-password)",
        ],
      },
    })
  }
  const email = normalizeEmail(opts.email)
  if (!isEmail(email)) throw new CampflareError("invalid_email")
  const team = opts.workspace?.trim().toLowerCase() || null
  const now = nowSeconds()
  const results = await env.DB.batch([
    ...addressChecks(env.DB, opts.ip, now),
    readCounter(env.DB, keys.reset(email), now),
    stmt(
      env.DB,
      `SELECT u.id, u.team_id, u.name, t.name AS team_name FROM users u JOIN teams t ON t.id = u.team_id
       WHERE u.email = ? AND u.deleted = 0 AND u.is_bot = 0
         AND (?2 IS NULL OR lower(t.domain) = ?2 OR lower(t.name) = ?2)
       LIMIT 20`,
      email,
      team,
    ),
  ])
  const wait = waitFor(results, now, counter(results[3]))
  if (wait !== undefined) throw tooManyAttempts(wait)
  await countFailure(env.DB, keys.reset(email), now, RESET_FREE_REQUESTS).run()
  const people = results[4]!.results as { id: string; team_id: string; name: string; team_name: string }[]
  for (const person of people) {
    const { code } = await createReset(env, {
      teamId: person.team_id,
      userId: person.id,
      createdBy: null,
      ttl: RESET_TTL,
    })
    lc.waitUntil(
      sender
        .send({
          to: email,
          subject: `Reset your Campflare password for ${person.team_name}`,
          text:
            `Someone asked to reset the password of @${person.name} in ${person.team_name}.\n\n` +
            `Set a new one here, within an hour:\n${resetUrl(lc.origin, code)}\n\n` +
            "If it wasn't you, ignore this email: your password stays as it is.\n",
        })
        .catch((error: unknown) => console.error("reset email failed", error)),
    )
  }
}

/** Seconds from an argument, checked against bounds (invalid_arguments outside them). */
export function ttlArg(value: number | undefined, fallback: number, min: number, max: number, name = "expires_in") {
  if (value === undefined) return fallback
  if (value < min || value > max) throw invalidArguments(`${name} is between ${min} and ${max} seconds`)
  return value
}
