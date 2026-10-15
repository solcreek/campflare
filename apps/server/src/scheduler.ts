import { DurableObject } from "cloudflare:workers"
import type { Actor } from "./api/context"
import { CampflareError } from "./api/errors"
import { nowSeconds, randomSecret } from "./api/ids"
import { requireWritable } from "./db/conversations"
import { postMessage } from "./db/messages"
import { all, first, stmt } from "./db/query"
import type { AppRow, ConversationRow, ReminderRow, ScheduledMessageRow, TeamRow, UserRow } from "./db/rows"
import { userJson } from "./api/shapes"
import { dndEvents, nextWindow } from "./dnd"
import type { Env } from "./env"
import { publish, publishEach } from "./events"
import type { PublishInput } from "./hub"
import { dmFromSystem, serverCtx, systemActor } from "./system-bot"

// Scheduled messages and reminders fire from here (docs/scheduling.md), and
// statuses expire and DND windows move on (docs/dnd.md). D1 is the truth; this
// object, one per workspace, only holds an alarm at the earliest due time.
// Each run claims a due row (a lease), posts, and finishes the row in the
// post's own batch, so a row is posted once however often the alarm runs.
// Statuses and windows need no claim: one guarded UPDATE each changes them,
// and only the run whose UPDATE did announces it.

/** How long a claim holds a row: a runner that dies mid-post leaves it to be tried again after this. */
export const CLAIM_SECONDS = 60
/** Attempts that end in an unexpected error before a row is given up as failed. */
export const MAX_ATTEMPTS = 5
/** Rows of each kind fired per run; more are left for the next, which comes at once. */
const PER_RUN = 50
/** Rows fired at once: reminders, and conversations' scheduled messages (each conversation's in order). */
export const CONCURRENCY = 5

type WaitUntil = (p: Promise<unknown>) => void

type Claimed = "scheduled_messages" | "reminders"

/**
 * A statement that fails, rolling back the batch it is in, unless the row
 * still holds this runner's claim: one whose lease ran out and was taken over
 * by another run, or that was deleted meanwhile, posts nothing. It inserts a
 * NULL into claim_guards.lost (NOT NULL) only when the claim is gone.
 */
const holdsClaim = (db: D1Database, table: Claimed, id: string, claim: string) =>
  stmt(
    db,
    `INSERT INTO claim_guards (lost) SELECT NULL WHERE NOT EXISTS (SELECT 1 FROM ${table} WHERE id = ? AND claim = ?)`,
    id,
    claim,
  )

/** Whether an error is holdsClaim() failing: someone else has the row now, or nobody does. */
export const isClaimLost = (error: unknown) => error instanceof Error && error.message.includes("claim_guards")

/** Claims a due row for this runner, with a token only it knows; undefined if it isn't due or is someone else's. */
export async function claimRow<T>(env: Env, table: Claimed, id: string, now = nowSeconds()): Promise<T | undefined> {
  const due = table === "scheduled_messages" ? "post_at <= ?" : "time <= ? AND fired = 0 AND complete_ts = 0"
  return first<T>(
    env.DB,
    `UPDATE ${table} SET claimed_until = ?, claim = ?, attempts = attempts + 1
     WHERE id = ? AND ${due} AND (claimed_until IS NULL OR claimed_until <= ?) RETURNING *`,
    now + CLAIM_SECONDS,
    randomSecret(16),
    id,
    now,
    now,
  )
}

export class Scheduler extends DurableObject<Env> {
  /** Makes sure the alarm rings by `at` (epoch seconds). */
  async arm(teamId: string, at: number, origin?: string): Promise<void> {
    await this.ctx.storage.put(origin ? { team: teamId, origin } : { team: teamId })
    const current = await this.ctx.storage.getAlarm()
    if (current === null || current > at * 1000) await this.ctx.storage.setAlarm(at * 1000)
  }

  /**
   * Fires what is due, then rings again at the next due time in D1. Whatever
   * the run hit, it re-arms; only when D1 can't say what's next does the alarm
   * fail, for Cloudflare to retry it.
   */
  override async alarm(): Promise<void> {
    const stored = await this.ctx.storage.get<string>(["team", "origin"])
    const teamId = stored.get("team")
    if (!teamId) return
    const pending: Promise<unknown>[] = []
    try {
      await runDue(this.env, teamId, (p) => pending.push(p), nowSeconds(), stored.get("origin"))
    } catch (error) {
      console.error("scheduler run failed", teamId, error)
    }
    await Promise.allSettled(pending)
    await this.rearm(teamId)
  }

  /**
   * Rings at the next due time in D1, unless it's already set to ring sooner:
   * an arm() that came in while the run awaited D1 may have set an earlier one.
   */
  async rearm(teamId: string): Promise<void> {
    const next = await nextDue(this.env, teamId)
    if (next === undefined) return
    const at = Math.max(next * 1000, Date.now())
    const current = await this.ctx.storage.getAlarm()
    if (current === null || current > at) await this.ctx.storage.setAlarm(at)
  }
}

/** What one run's rows share: the workspace, the clock, and the built-in bot, looked up at most once. */
interface Run {
  env: Env
  team: TeamRow
  waitUntil: WaitUntil
  now: number
  bot: () => Promise<Actor>
  /** The server's origin, for the URLs in a user_change. */
  origin: string
}

/** Runs `fn` over `items`, at most `limit` at a time. */
async function pool<T>(items: T[], limit: number, fn: (item: T) => Promise<void>) {
  const queue = [...items]
  const worker = async () => {
    for (let item = queue.shift(); item !== undefined; item = queue.shift()) await fn(item)
  }
  await Promise.all(Array.from({ length: Math.min(limit, queue.length) }, worker))
}

/** Runs a row's firing; an error is logged and leaves the row to its claim, never stopping the others. */
async function isolated(kind: string, id: string, fire: Promise<void>) {
  try {
    await fire
  } catch (error) {
    console.error(`${kind} ${id} failed`, error)
  }
}

/**
 * Sets the workspace's alarm to ring by `at`: after the row is written, before the method answers.
 * `origin`, the server's, is kept for what the alarm sends without a row to say it (user_change).
 */
export async function armScheduler(env: Env, teamId: string, at: number, origin?: string): Promise<void> {
  await env.SCHEDULER.get(env.SCHEDULER.idFromName(teamId)).arm(teamId, at, origin)
}

/**
 * Fires the due scheduled messages and reminders of a workspace (up to
 * PER_RUN of each): CONCURRENCY at a time, each conversation's messages in
 * due order.
 */
export async function runDue(
  env: Env,
  teamId: string,
  waitUntil: WaitUntil,
  now = nowSeconds(),
  origin = "http://localhost",
): Promise<void> {
  const db = env.DB
  const [messages, reminders, team] = await db.batch([
    stmt(
      db,
      `SELECT id, channel_id FROM scheduled_messages WHERE team_id = ? AND post_at <= ? AND (claimed_until IS NULL OR claimed_until <= ?)
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
  if (!teamRow) return
  let bot: Promise<Actor> | undefined
  const run: Run = { env, team: teamRow, waitUntil, now, origin, bot: () => (bot ??= systemActor(env, teamRow)) }
  const byChannel = new Map<string, string[]>()
  for (const { id, channel_id } of messages!.results as { id: string; channel_id: string }[]) {
    byChannel.set(channel_id, [...(byChannel.get(channel_id) ?? []), id])
  }
  await Promise.all([
    pool([...byChannel.values()], CONCURRENCY, async (ids) => {
      for (const id of ids) await isolated("scheduled message", id, fireScheduledMessage(run, id))
    }),
    pool(reminders!.results as { id: string }[], CONCURRENCY, ({ id }) =>
      isolated("reminder", id, fireReminder(run, id)),
    ),
    isolated("status expiry", teamId, expireStatuses(run)),
    isolated("dnd window", teamId, moveDndWindows(run)),
  ])
}

/** The earliest time anything of the workspace is due (a claimed row: when its claim ends). */
export async function nextDue(env: Env, teamId: string): Promise<number | undefined> {
  const row = await first<{ due: number | null }>(
    env.DB,
    `SELECT MIN(due) AS due FROM (
       SELECT MAX(post_at, COALESCE(claimed_until, 0)) AS due FROM scheduled_messages WHERE team_id = ?1
       UNION ALL
       SELECT MAX(time, COALESCE(claimed_until, 0)) FROM reminders WHERE team_id = ?1 AND fired = 0 AND complete_ts = 0
       UNION ALL
       SELECT MIN(status_expiration) FROM users WHERE team_id = ?1 AND status_expiration > 0 AND deleted = 0
       UNION ALL
       SELECT MIN(dnd_window_end) FROM users WHERE team_id = ?1 AND dnd_window_end > 0 AND deleted = 0)`,
    teamId,
  )
  return row?.due ?? undefined
}

/** One scheduled message, if this runner gets the claim: posted, or dropped when it can't be. */
async function fireScheduledMessage(run: Run, id: string) {
  const { env, team, waitUntil } = run
  const row = await claimRow<ScheduledMessageRow>(env, "scheduled_messages", id, run.now)
  if (!row) return
  try {
    const ts = await postScheduled(env, team, row, waitUntil)
    removed(env, row, waitUntil, { reason: "posted", ts })
  } catch (error) {
    if (isClaimLost(error)) return
    if (!(error instanceof CampflareError) && row.attempts < MAX_ATTEMPTS) {
      // Something else broke (D1): the claim runs out and the next run tries again.
      console.error("scheduled message failed, will retry", row.id, error)
      return
    }
    await dropScheduled(run, row, error instanceof CampflareError ? error.code : "internal_error")
  }
}

/**
 * Posts a claimed row as chat.postMessage would, as its poster, checking what
 * posting checks now. The row goes in the post's batch, which fails unless the
 * claim is still this runner's.
 */
export async function postScheduled(env: Env, team: TeamRow, row: ScheduledMessageRow, waitUntil: WaitUntil) {
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
  // The scopes of the token that scheduled it, as they were: a bot without chat:write.public must
  // still be in the channel. The token itself may be gone: the message is its poster's (docs/scheduling.md).
  const scopes = row.scopes.split(",").filter(Boolean)
  const auth: Actor = appRow
    ? { kind: "bot", team, user: poster, app: appRow, scopes }
    : { kind: "user", team, user: poster, scopes }
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
    [
      holdsClaim(db, "scheduled_messages", row.id, row.claim!),
      stmt(db, "DELETE FROM scheduled_messages WHERE id = ? AND claim = ?", row.id, row.claim),
    ],
  )
  return posted.ts
}

/**
 * A scheduled message that can't be posted: dropped, and its poster told in a
 * DM from the built-in bot when they are a person still here to read it.
 */
async function dropScheduled(run: Run, row: ScheduledMessageRow, error: string) {
  const { env, waitUntil } = run
  const drop = stmt(env.DB, "DELETE FROM scheduled_messages WHERE id = ? AND claim = ?", row.id, row.claim)
  const poster = row.app_id
    ? undefined
    : await first<UserRow>(env.DB, "SELECT * FROM users WHERE id = ? AND deleted = 0", row.user_id)
  try {
    if (!poster) throw new Error("nobody to tell")
    const ctx = serverCtx(env, await run.bot(), row.origin, waitUntil)
    const excerpt = row.text.length > 200 ? `${row.text.slice(0, 200)}…` : row.text
    const text = `Your scheduled message to <#${row.channel_id}> couldn't be sent (${error})${excerpt ? `: ${excerpt}` : "."}`
    await dmFromSystem(ctx, poster.id, text, [holdsClaim(env.DB, "scheduled_messages", row.id, row.claim!), drop])
  } catch (dmError) {
    // Without the DM it still goes, unless the claim is someone else's now.
    if (isClaimLost(dmError) || !(await drop.run()).meta.changes) return
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
async function fireReminder(run: Run, id: string) {
  const { env, waitUntil } = run
  const row = await claimRow<ReminderRow>(env, "reminders", id, run.now)
  if (!row) return
  const done = stmt(
    env.DB,
    "UPDATE reminders SET fired = 1, claimed_until = NULL WHERE id = ? AND claim = ?",
    row.id,
    row.claim,
  )
  try {
    const person = await first<UserRow>(env.DB, "SELECT * FROM users WHERE id = ? AND deleted = 0", row.user_id)
    if (!person) {
      await done.run()
      return
    }
    const ctx = serverCtx(env, await run.bot(), row.origin, waitUntil)
    await dmFromSystem(ctx, person.id, `Reminder: ${row.text}`, [
      holdsClaim(env.DB, "reminders", row.id, row.claim!),
      done,
    ])
    reminderChanged(env, { ...row, fired: 1, claimed_until: null }, waitUntil)
  } catch (error) {
    if (isClaimLost(error)) return
    console.error("reminder failed", row.id, error)
    if (row.attempts >= MAX_ATTEMPTS) await done.run()
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

/**
 * Clears the statuses past their status_expiration (up to PER_RUN) and tells
 * the workspace (user_change), as Slack does when a status expires. One
 * statement both finds and clears them, so a status set again meanwhile, with
 * a later expiration or none, isn't touched, and only the run that cleared a
 * status announces it.
 */
async function expireStatuses(run: Run) {
  const { env, team, now } = run
  const cleared = await all<UserRow>(
    env.DB,
    `UPDATE users SET status_text = '', status_emoji = '', status_expiration = 0, updated = ?2
     WHERE id IN (SELECT id FROM users WHERE team_id = ?1 AND status_expiration > 0 AND status_expiration <= ?2
                    AND deleted = 0 LIMIT ?3)
       AND status_expiration > 0 AND status_expiration <= ?2
     RETURNING *`,
    team.id,
    now,
    PER_RUN,
  )
  publishEach(
    run,
    team.id,
    cleared.map((u): PublishInput => ({
      teamId: team.id,
      audience: "team",
      event: { type: "user_change", user: userJson(u, run.origin) },
    })),
  )
}

/**
 * Moves each DND window that has ended (up to PER_RUN) on to the person's next
 * one, and tells them and the workspace (dnd_updated, dnd_updated_user): their
 * next_dnd_* changed. Each move is guarded on the row as read, so a schedule
 * or time zone changed meanwhile keeps the window its change computed, and a
 * second run moves nothing twice.
 */
async function moveDndWindows(run: Run) {
  const { env, team, now } = run
  const db = env.DB
  const ended = await all<UserRow>(
    db,
    "SELECT * FROM users WHERE team_id = ? AND dnd_window_end > 0 AND dnd_window_end <= ? AND deleted = 0 LIMIT ?",
    team.id,
    now,
    PER_RUN,
  )
  if (ended.length === 0) return
  const moves = ended.map((u) => {
    const w = nextWindow(u, now)
    return stmt(
      db,
      `UPDATE users SET dnd_window_start = ?, dnd_window_end = ?
       WHERE id = ? AND dnd_window_end = ? AND dnd_start = ? AND dnd_end = ? AND dnd_days = ? AND tz = ?
         AND dnd_skipped_at = ? RETURNING *`,
      w?.start ?? 0,
      w?.end ?? 0,
      u.id,
      u.dnd_window_end,
      u.dnd_start,
      u.dnd_end,
      u.dnd_days,
      u.tz,
      u.dnd_skipped_at,
    )
  })
  const moved = (await db.batch(moves)).flatMap((r) => r.results as UserRow[])
  publishEach(
    run,
    team.id,
    moved.flatMap((u) => dndEvents(team.id, u, now)),
  )
}
