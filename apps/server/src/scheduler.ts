import { DurableObject } from "cloudflare:workers"
import type { Actor } from "./api/context"
import { CampflareError } from "./api/errors"
import { nowSeconds } from "./api/ids"
import { DEFAULT_BOT_SCOPES, FULL_USER_SCOPES } from "./api/scopes"
import { requireWritable } from "./db/conversations"
import { postMessage } from "./db/messages"
import { first, run, stmt } from "./db/query"
import type { AppRow, ConversationRow, ReminderRow, ScheduledMessageRow, TeamRow, UserRow } from "./db/rows"
import type { Env } from "./env"
import { publish } from "./events"
import { dmFromSystem, serverCtx, systemActor } from "./system-bot"

// Scheduled messages and reminders fire from here (docs/scheduling.md). D1 is
// the truth; this object, one per workspace, only holds an alarm at the
// earliest due time. Each run claims a due row (a lease), posts, and finishes
// the row in the post's own batch, so a row is posted once however often the
// alarm runs.

/** How long a claim holds a row: a runner that dies mid-post leaves it to be tried again after this. */
export const CLAIM_SECONDS = 60
/** Attempts that end in an unexpected error before a row is given up as failed. */
export const MAX_ATTEMPTS = 5
/** Rows of each kind fired per run; more are left for the next, which comes at once. */
const PER_RUN = 50

type WaitUntil = (p: Promise<unknown>) => void

export class Scheduler extends DurableObject<Env> {
  /** Makes sure the alarm rings by `at` (epoch seconds). */
  async arm(teamId: string, at: number): Promise<void> {
    await this.ctx.storage.put("team", teamId)
    const current = await this.ctx.storage.getAlarm()
    if (current === null || current > at * 1000) await this.ctx.storage.setAlarm(at * 1000)
  }

  /** Fires what is due, then rings again at the next due time in D1 (none: no alarm). */
  override async alarm(): Promise<void> {
    const teamId = await this.ctx.storage.get<string>("team")
    if (!teamId) return
    const pending: Promise<unknown>[] = []
    const next = await runDue(this.env, teamId, (p) => pending.push(p))
    await Promise.allSettled(pending)
    if (next !== undefined) await this.ctx.storage.setAlarm(Math.max(next * 1000, Date.now()))
  }
}

/** Sets the workspace's alarm to ring by `at`: after the row is written, before the method answers. */
export async function armScheduler(env: Env, teamId: string, at: number): Promise<void> {
  await env.SCHEDULER.get(env.SCHEDULER.idFromName(teamId)).arm(teamId, at)
}

/**
 * Fires every due scheduled message and reminder of a workspace (up to
 * PER_RUN of each), in due order; answers the next due time, if any.
 */
export async function runDue(env: Env, teamId: string, waitUntil: WaitUntil, now = nowSeconds()) {
  const db = env.DB
  const [messages, reminders, team] = await db.batch([
    stmt(
      db,
      `SELECT id FROM scheduled_messages WHERE team_id = ? AND post_at <= ? AND (claimed_until IS NULL OR claimed_until <= ?)
       ORDER BY post_at, created LIMIT ?`,
      teamId,
      now,
      now,
      PER_RUN,
    ),
    stmt(
      db,
      `SELECT id FROM reminders WHERE team_id = ? AND time <= ? AND fired = 0 AND complete_ts = 0
         AND (claimed_until IS NULL OR claimed_until <= ?) ORDER BY time LIMIT ?`,
      teamId,
      now,
      now,
      PER_RUN,
    ),
    stmt(db, "SELECT * FROM teams WHERE id = ?", teamId),
  ])
  const teamRow = team!.results[0] as TeamRow | undefined
  if (!teamRow) return undefined
  for (const { id } of messages!.results as { id: string }[]) {
    await fireScheduledMessage(env, teamRow, id, waitUntil, now)
  }
  for (const { id } of reminders!.results as { id: string }[]) {
    await fireReminder(env, teamRow, id, waitUntil, now)
  }
  return nextDue(env, teamId)
}

/** The earliest time anything of the workspace is due (a claimed row: when its claim ends). */
export async function nextDue(env: Env, teamId: string): Promise<number | undefined> {
  const row = await first<{ due: number | null }>(
    env.DB,
    `SELECT MIN(due) AS due FROM (
       SELECT MAX(post_at, COALESCE(claimed_until, 0)) AS due FROM scheduled_messages WHERE team_id = ?1
       UNION ALL
       SELECT MAX(time, COALESCE(claimed_until, 0)) FROM reminders WHERE team_id = ?1 AND fired = 0 AND complete_ts = 0)`,
    teamId,
  )
  return row?.due ?? undefined
}

/** One scheduled message, if this runner gets the claim: posted, or dropped when it can't be. */
export async function fireScheduledMessage(
  env: Env,
  team: TeamRow,
  id: string,
  waitUntil: WaitUntil,
  now = nowSeconds(),
) {
  const row = await first<ScheduledMessageRow>(
    env.DB,
    `UPDATE scheduled_messages SET claimed_until = ?, attempts = attempts + 1
     WHERE id = ? AND post_at <= ? AND (claimed_until IS NULL OR claimed_until <= ?) RETURNING *`,
    now + CLAIM_SECONDS,
    id,
    now,
    now,
  )
  if (!row) return
  try {
    const ts = await postScheduled(env, team, row, waitUntil)
    removed(env, row, waitUntil, { reason: "posted", ts })
  } catch (error) {
    if (!(error instanceof CampflareError) && row.attempts < MAX_ATTEMPTS) {
      // Something else broke (D1): the claim runs out and the next run tries again.
      console.error("scheduled message failed, will retry", row.id, error)
      return
    }
    await dropScheduled(env, team, row, error instanceof CampflareError ? error.code : "internal_error", waitUntil)
  }
}

/** Posts it as chat.postMessage would, as its poster, checking what posting checks now; the row goes with the post. */
async function postScheduled(env: Env, team: TeamRow, row: ScheduledMessageRow, waitUntil: WaitUntil) {
  const db = env.DB
  const [user, app, conversation] = await db.batch([
    stmt(db, "SELECT * FROM users WHERE id = ? AND deleted = 0", row.user_id),
    stmt(db, "SELECT * FROM apps WHERE id = ?", row.app_id),
    stmt(db, "SELECT * FROM conversations WHERE id = ?", row.channel_id),
  ])
  const poster = user!.results[0] as UserRow | undefined
  const appRow = app!.results[0] as AppRow | undefined
  const c = conversation!.results[0] as ConversationRow | undefined
  if (!poster || (row.app_id && !appRow)) throw new CampflareError("account_inactive")
  if (!c) throw new CampflareError("channel_not_found")
  // The poster's scopes don't matter now: the message is theirs, not the token's (docs/scheduling.md).
  const auth: Actor = appRow
    ? { kind: "bot", team, user: poster, app: appRow, scopes: DEFAULT_BOT_SCOPES }
    : { kind: "user", team, user: poster, scopes: FULL_USER_SCOPES }
  const ctx = serverCtx(env, auth, row.origin, waitUntil)
  await requireWritable(ctx, c)
  const { row: posted } = await postMessage(
    ctx,
    c,
    {
      user_id: poster.id,
      bot_id: appRow?.bot_id ?? null,
      app_id: appRow?.id ?? null,
      username: row.username,
      text: row.text,
      blocks: row.blocks,
      attachments: row.attachments,
      metadata: row.metadata,
      thread_ts: row.thread_ts,
      subtype: row.thread_ts && row.reply_broadcast ? "thread_broadcast" : null,
    },
    [stmt(db, "DELETE FROM scheduled_messages WHERE id = ?", row.id)],
  )
  return posted.ts
}

/**
 * A scheduled message that can't be posted: dropped, and its poster told in a
 * DM from the built-in bot when they are a person still here to read it.
 */
async function dropScheduled(env: Env, team: TeamRow, row: ScheduledMessageRow, error: string, waitUntil: WaitUntil) {
  const drop = stmt(env.DB, "DELETE FROM scheduled_messages WHERE id = ?", row.id)
  const poster = row.app_id
    ? undefined
    : await first<UserRow>(env.DB, "SELECT * FROM users WHERE id = ? AND deleted = 0", row.user_id)
  try {
    if (!poster) throw new Error("nobody to tell")
    const ctx = serverCtx(env, await systemActor(env, team), row.origin, waitUntil)
    const excerpt = row.text.length > 200 ? `${row.text.slice(0, 200)}…` : row.text
    const text = `Your scheduled message to <#${row.channel_id}> couldn't be sent (${error})${excerpt ? `: ${excerpt}` : "."}`
    await dmFromSystem(ctx, poster.id, text, [drop])
  } catch {
    await drop.run()
  }
  removed(env, row, waitUntil, { reason: "failed", error })
}

/** Tells the poster's clients a scheduled message is gone from their list, and why. */
export function removed(
  env: Env,
  row: Pick<ScheduledMessageRow, "id" | "team_id" | "channel_id" | "user_id">,
  waitUntil: WaitUntil,
  why: { reason: "posted" | "deleted" | "failed"; ts?: string; error?: string },
) {
  publish(
    { env, waitUntil },
    {
      teamId: row.team_id,
      audience: [row.user_id],
      rtmOnly: true,
      event: { type: "scheduled_message_removed", scheduled_message_id: row.id, channel: row.channel_id, ...why },
    },
  )
}

/** One reminder, if this runner gets the claim: a DM from the built-in bot, unless its person has gone. */
export async function fireReminder(env: Env, team: TeamRow, id: string, waitUntil: WaitUntil, now = nowSeconds()) {
  const row = await first<ReminderRow>(
    env.DB,
    `UPDATE reminders SET claimed_until = ?, attempts = attempts + 1
     WHERE id = ? AND time <= ? AND fired = 0 AND complete_ts = 0 AND (claimed_until IS NULL OR claimed_until <= ?)
     RETURNING *`,
    now + CLAIM_SECONDS,
    id,
    now,
    now,
  )
  if (!row) return
  const done = stmt(env.DB, "UPDATE reminders SET fired = 1, claimed_until = NULL WHERE id = ?", row.id)
  try {
    const person = await first<UserRow>(env.DB, "SELECT * FROM users WHERE id = ? AND deleted = 0", row.user_id)
    if (!person) {
      await done.run()
      return
    }
    const ctx = serverCtx(env, await systemActor(env, team), row.origin, waitUntil)
    await dmFromSystem(ctx, person.id, `Reminder: ${row.text}`, [done])
    reminderChanged(env, { ...row, fired: 1, claimed_until: null }, waitUntil)
  } catch (error) {
    console.error("reminder failed", row.id, error)
    if (row.attempts >= MAX_ATTEMPTS) await run(env.DB, "UPDATE reminders SET fired = 1 WHERE id = ?", row.id)
  }
}

/** A reminder as Slack's reminders.* answer it. */
export function reminderJson(r: ReminderRow) {
  return {
    id: r.id,
    creator: r.creator_id,
    user: r.user_id,
    text: r.text,
    recurring: false,
    time: r.time,
    complete_ts: r.complete_ts,
  }
}

export function reminderChanged(env: Env, r: ReminderRow, waitUntil: WaitUntil) {
  publish(
    { env, waitUntil },
    {
      teamId: r.team_id,
      audience: [r.user_id],
      rtmOnly: true,
      event: { type: "reminder_changed", reminder: reminderJson(r) },
    },
  )
}
