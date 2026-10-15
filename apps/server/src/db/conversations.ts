import { audienceOf, channelType, publish } from "../events"
import type { Actor, Ctx } from "../api/context"
import { CampflareError } from "../api/errors"
import { requireConversationScope } from "../api/scopes"
import { ids, nowSeconds } from "../api/ids"
import { conversationJson } from "../api/shapes"
import { first, isUniqueViolation, run, stmt } from "./query"
import type { ConversationRow, MemberRow, UserRow } from "./rows"

/**
 * The actor's membership, read with the conversation itself so the access
 * check that follows needs no query. null: not a member. Rows from elsewhere
 * have no entry and are looked up as before.
 */
const actorMembership = new WeakMap<ConversationRow, MemberRow | null>()

/** Conversations, with the actor's membership row alongside (m_*). */
const WITH_MEMBERSHIP = `SELECT c.*, m.last_read AS m_last_read, m.joined AS m_joined FROM conversations c
  LEFT JOIN members m ON m.conversation_id = c.id AND m.user_id = ?`

type WithMembership = ConversationRow & { m_last_read: string | null; m_joined: number | null }

async function findWithMembership(ctx: Ctx<Actor>, where: string, ...params: unknown[]) {
  const row = await first<WithMembership>(ctx.env.DB, `${WITH_MEMBERSHIP} WHERE ${where}`, ctx.auth.user.id, ...params)
  if (!row) throw new CampflareError("channel_not_found")
  const { m_last_read: lastRead, m_joined: joined, ...c } = row
  actorMembership.set(
    c,
    joined === null ? null : { conversation_id: c.id, user_id: ctx.auth.user.id, last_read: lastRead!, joined },
  )
  // The token's scope for this type of conversation, once it's one the actor may see: a hidden
  // one stays channel_not_found (requireReadable), so a missing scope never reveals it.
  const visible = joined !== null || (c.kind === "channel" && !c.is_private)
  if (ctx.verb && visible) requireConversationScope(ctx.auth, c, ctx.verb)
  return c
}

export async function getConversation(ctx: Ctx<Actor>, id: string): Promise<ConversationRow> {
  return findWithMembership(ctx, "c.id = ? AND c.team_id = ?", id, ctx.auth.team.id)
}

/**
 * The conversation a `channel` argument names: an id, a "#name" (or bare
 * name), or a user id, which chat.postMessage treats as that person's DM.
 */
export async function resolveConversation(ctx: Ctx<Actor>, ref: string): Promise<ConversationRow> {
  if (/^[UW][A-Z0-9]+$/.test(ref)) {
    const user = await first<UserRow>(
      ctx.env.DB,
      "SELECT * FROM users WHERE id = ? AND team_id = ? AND deleted = 0",
      ref,
      ctx.auth.team.id,
    )
    if (!user) throw new CampflareError("channel_not_found")
    return openConversation(ctx, [user.id])
  }
  if (/^[CDG][A-Z0-9]+$/.test(ref)) return getConversation(ctx, ref)
  const name = ref.replace(/^#/, "").toLowerCase()
  return findWithMembership(ctx, "c.team_id = ? AND c.kind = 'channel' AND c.name = ?", ctx.auth.team.id, name)
}

export async function membership(ctx: Ctx<Actor>, conversationId: string, userId = ctx.auth.user.id) {
  return first<MemberRow>(
    ctx.env.DB,
    "SELECT * FROM members WHERE conversation_id = ? AND user_id = ?",
    conversationId,
    userId,
  )
}

/** The actor's membership of c: known from fetching c, or looked up. */
export async function actorMember(ctx: Ctx<Actor>, c: ConversationRow): Promise<MemberRow | undefined> {
  const known = actorMembership.get(c)
  return known === undefined ? membership(ctx, c.id) : (known ?? undefined)
}

/** Reading is for members, and for anyone in the team on a public channel. */
export async function requireReadable(ctx: Ctx<Actor>, c: ConversationRow): Promise<MemberRow | undefined> {
  const member = await actorMember(ctx, c)
  if (!member && (c.kind !== "channel" || c.is_private)) throw new CampflareError("channel_not_found")
  return member
}

export async function requireMember(ctx: Ctx<Actor>, c: ConversationRow): Promise<MemberRow> {
  const member = await requireReadable(ctx, c)
  if (!member) throw new CampflareError("not_in_channel")
  return member
}

export function requireNotArchived(c: ConversationRow) {
  if (c.is_archived) throw new CampflareError("is_archived")
}

/** Bots may post in any public channel (chat:write.public); everyone else must be a member. */
export async function requireWritable(ctx: Ctx<Actor>, c: ConversationRow) {
  requireNotArchived(c)
  if (ctx.auth.kind === "bot" && c.kind === "channel" && !c.is_private && ctx.auth.scopes.includes("chat:write.public"))
    return
  await requireMember(ctx, c)
}

/**
 * The DM (one other person, or yourself) or group DM (2–8 others) with these
 * users, created on first use. Group DMs are named as Slack names them.
 */
export async function openConversation(ctx: Ctx<Actor>, userIds: string[]): Promise<ConversationRow> {
  const self = ctx.auth.user
  const others = [...new Set(userIds)].filter((u) => u !== self.id)
  const everyone = [...new Set([self.id, ...others])].toSorted()
  if (others.length > 8) throw new CampflareError("too_many_users")
  const users = await ctx.env.DB.prepare(
    `SELECT * FROM users WHERE team_id = ? AND deleted = 0 AND id IN (${everyone.map(() => "?").join(", ")})`,
  )
    .bind(ctx.auth.team.id, ...everyone)
    .all<UserRow>()
  if (users.results.length !== everyone.length) throw new CampflareError("user_not_found")
  const kind = others.length <= 1 ? "im" : "mpim"
  if (ctx.verb) requireConversationScope(ctx.auth, { kind, is_private: 1 }, ctx.verb)
  const memberKey = everyone.join(",")
  const existing = await first<ConversationRow>(
    ctx.env.DB,
    "SELECT * FROM conversations WHERE team_id = ? AND member_key = ?",
    ctx.auth.team.id,
    memberKey,
  )
  if (existing) return existing

  const now = nowSeconds()
  const id = kind === "im" ? ids.im() : ids.mpim()
  const handles = users.results
    .map((u) => u.name)
    .toSorted()
    .join("--")
  const name = kind === "im" ? (others[0] ?? self.id) : `mpdm-${handles}-1`
  try {
    await ctx.env.DB.batch([
      stmt(
        ctx.env.DB,
        `INSERT INTO conversations (id, team_id, kind, name, is_private, creator, member_key, created, updated)
         VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?)`,
        id,
        ctx.auth.team.id,
        kind,
        name,
        self.id,
        memberKey,
        now,
        now,
      ),
      ...everyone.map((u) =>
        stmt(ctx.env.DB, "INSERT INTO members (conversation_id, user_id, joined) VALUES (?, ?, ?)", id, u, now),
      ),
    ])
  } catch (error) {
    // Opened concurrently by someone else: theirs is the one.
    if (!isUniqueViolation(error)) throw error
    const row = await first<ConversationRow>(
      ctx.env.DB,
      "SELECT * FROM conversations WHERE team_id = ? AND member_key = ?",
      ctx.auth.team.id,
      memberKey,
    )
    if (row) return row
    throw error
  }
  const row = (await getConversation(ctx, id))!
  for (const u of everyone) {
    const imUser = kind === "im" ? (everyone.find((x) => x !== u) ?? u) : undefined
    publish(ctx, {
      teamId: ctx.auth.team.id,
      audience: [u],
      event: {
        type: kind === "im" ? "im_created" : "mpim_open",
        user: u,
        channel: conversationJson(row, { member: { last_read: "0000000000.000000" }, imUser }),
      },
    })
  }
  return row
}

/** For an im, the other person (or yourself, in your self-DM). */
export function imPeer(c: ConversationRow, selfId: string): string | undefined {
  if (c.kind !== "im" || !c.member_key) return undefined
  const members = c.member_key.split(",")
  return members.find((u) => u !== selfId) ?? members[0]
}

export async function addMember(ctx: Ctx<Actor>, c: ConversationRow, userId: string, inviter?: string) {
  const res = await run(
    ctx.env.DB,
    "INSERT OR IGNORE INTO members (conversation_id, user_id, joined) VALUES (?, ?, ?)",
    c.id,
    userId,
    nowSeconds(),
  )
  if (userId === ctx.auth.user.id) actorMembership.delete(c)
  if (!res.meta.changes) return false
  const audience = await audienceOf(ctx, c.id)
  publish(ctx, {
    teamId: c.team_id,
    audience,
    event: {
      type: "member_joined_channel",
      user: userId,
      channel: c.id,
      channel_type: channelType(c) === "channel" ? "C" : "G",
      team: c.team_id,
      ...(inviter ? { inviter } : {}),
    },
  })
  return true
}

export async function removeMember(ctx: Ctx<Actor>, c: ConversationRow, userId: string) {
  const audience = await audienceOf(ctx, c.id)
  const res = await run(ctx.env.DB, "DELETE FROM members WHERE conversation_id = ? AND user_id = ?", c.id, userId)
  if (userId === ctx.auth.user.id) actorMembership.delete(c)
  if (!res.meta.changes) return false
  publish(ctx, {
    teamId: c.team_id,
    audience,
    event: {
      type: "member_left_channel",
      user: userId,
      channel: c.id,
      channel_type: channelType(c) === "channel" ? "C" : "G",
      team: c.team_id,
    },
  })
  return true
}

/** What a channel name may hold: lower case letters (any script's), digits, - and _. */
export const CHANNEL_NAME_CHARS = "\\p{Ll}\\p{Lo}\\p{N}_-"
export const MAX_CHANNEL_NAME = 80

/** Slack channel names: lower case, digits, - and _, at most 80 characters. */
export function validChannelName(name: string): string {
  const normalized = name.replace(/^#/, "").trim().toLowerCase()
  if (
    !normalized ||
    normalized.length > MAX_CHANNEL_NAME ||
    !new RegExp(`^[${CHANNEL_NAME_CHARS}]+$`, "u").test(normalized)
  ) {
    throw new CampflareError("invalid_name_specials")
  }
  return normalized
}
