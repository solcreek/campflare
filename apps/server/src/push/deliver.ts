import type { Env } from "../env"
import type { Connection, PublishInput } from "../hub"
import type { PushSubscriptionRow } from "../methods/push"
import { itemPush, namedUsers, type Names, type PushItem } from "./payload"
import { sendPush, type PushMessage, type PushOutcome, type Target } from "./send"
import { loadVapid } from "./vapid"

// Delivery of activity items to people's devices (docs/push.md), inside the
// workspace's TeamHub: it already receives every activity_added event after
// the response, so posting a message waits for none of this.

/** A link that said it's active this recently, and not inactive since, means the person is looking. */
export const ACTIVE_WINDOW_MS = 2 * 60 * 1000
/** Pushes per person per minute at most; past it items are only in the inbox. */
export const PUSH_PER_MINUTE = 30
/** Retries of a push the service couldn't take (429, 5xx, no answer): after these delays, then dropped. */
export const PUSH_RETRY_DELAYS_MS = [10_000, 60_000, 300_000]
/** A Retry-After longer than this is cut to it. */
const MAX_RETRY_AFTER_MS = 60 * 60 * 1000

type Sub = Pick<PushSubscriptionRow, "id" | "endpoint" | "p256dh" | "auth">

/** One push to send: to whom, where, what, and (on a retry) its row in push_pending. */
interface Outgoing {
  userId: string
  sub: Sub
  message: PushMessage
  /** For the VAPID subject's default. */
  origin: string
  retry?: { id: number; attempts: number }
}

/** Whether a link's client said it is active (`campflare.active`) within the window. */
export const isActiveLink = (conn: Pick<Connection, "kind" | "activeAt"> | null, now: number) =>
  conn?.kind === "rtm" && (conn.activeAt ?? 0) > now - ACTIVE_WINDOW_MS

export class PushDelivery {
  /** The workspace's subscriptions by person, read from D1 once and dropped on a change. */
  private subscriptions?: { teamId: string; byUser: Promise<Map<string, Sub[]>> }

  constructor(
    private readonly ctx: DurableObjectState,
    private readonly env: Env,
    private readonly scheduleAlarm: (at: number) => Promise<void>,
  ) {
    const sql = ctx.storage.sql
    // Pushes a push service couldn't take yet, until they go or run out of retries. Only
    // the subscription's id is kept: a retry sends to the subscription as it is then, if
    // it is still the same person's.
    sql.exec(`CREATE TABLE IF NOT EXISTS push_pending (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      team_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      subscription_id TEXT NOT NULL,
      origin TEXT NOT NULL,
      message TEXT NOT NULL,
      attempts INTEGER NOT NULL,
      due INTEGER NOT NULL
    )`)
    sql.exec("CREATE INDEX IF NOT EXISTS push_pending_subscription ON push_pending (subscription_id)")
    // Pushes per person per minute, for the cap.
    sql.exec(`CREATE TABLE IF NOT EXISTS push_counts (
      user_id TEXT NOT NULL,
      minute INTEGER NOT NULL,
      count INTEGER NOT NULL,
      PRIMARY KEY (user_id, minute)
    )`)
  }

  /** Subscriptions changed: read them again for the next push; those removed lose their pending retries. */
  forget(removed: string[] = []) {
    this.subscriptions = undefined
    for (const id of removed) this.ctx.storage.sql.exec("DELETE FROM push_pending WHERE subscription_id = ?", id)
  }

  private subscriptionsOf(teamId: string): Promise<Map<string, Sub[]>> {
    if (this.subscriptions?.teamId !== teamId) {
      const byUser = this.env.DB.prepare(
        "SELECT id, user_id, endpoint, p256dh, auth FROM push_subscriptions WHERE team_id = ?",
      )
        .bind(teamId)
        .all<Sub & { user_id: string }>()
        .then(({ results }) => {
          const map = new Map<string, Sub[]>()
          for (const { user_id, ...sub } of results) map.set(user_id, [...(map.get(user_id) ?? []), sub])
          return map
        })
      // A failed read is tried again by the next item, not remembered.
      byUser.catch(() => {
        if (this.subscriptions?.byUser === byUser) this.subscriptions = undefined
      })
      this.subscriptions = { teamId, byUser }
    }
    return this.subscriptions.byUser
  }

  /** Whether one of the person's RTM links said it's active, recently: they're looking at the app. */
  isActive(userId: string, now = Date.now()): boolean {
    return this.ctx
      .getWebSockets(`user:${userId}`)
      .some((ws) => isActiveLink(ws.deserializeAttachment() as Connection | null, now))
  }

  /** Counts one push for the person this minute: false past the cap. */
  private underCap(userId: string, now: number): boolean {
    const minute = Math.floor(now / 60_000)
    const sql = this.ctx.storage.sql
    const [row] = sql
      .exec<{ count: number }>(
        `INSERT INTO push_counts (user_id, minute, count) VALUES (?, ?, 1)
         ON CONFLICT (user_id, minute) DO UPDATE SET count = count + 1 RETURNING count`,
        userId,
        minute,
      )
      .toArray()
    if (row!.count === 1) sql.exec("DELETE FROM push_counts WHERE minute < ?", minute - 1)
    return row!.count <= PUSH_PER_MINUTE
  }

  /** The names titles and bodies need, in one batch: the actors and those mentioned, the conversations. */
  private async names(items: PushItem[]): Promise<Names> {
    const users = new Set<string>()
    for (const item of items) {
      if (item.actor) users.add(item.actor)
      for (const u of namedUsers(item.message?.text ?? "")) users.add(u)
    }
    const db = this.env.DB
    const [people, conversations] = await db.batch([
      db
        .prepare("SELECT id, name, real_name, display_name FROM users WHERE id IN (SELECT value FROM json_each(?))")
        .bind(JSON.stringify([...users])),
      db
        .prepare("SELECT id, name, kind FROM conversations WHERE id IN (SELECT value FROM json_each(?))")
        .bind(JSON.stringify([...new Set(items.map((i) => i.channel))])),
    ])
    type Person = { id: string; name: string; real_name: string; display_name: string }
    return {
      users: new Map((people!.results as Person[]).map((u) => [u.id, u.display_name || u.real_name || u.name])),
      conversations: new Map(
        (conversations!.results as { id: string; name: string; kind: string }[]).map((c) => [c.id, c]),
      ),
    }
  }

  /**
   * Pushes the activity items among published events that should notify, to
   * their recipients' devices: not to someone looking at the app, nor past
   * the cap. Nothing is read for people without devices.
   */
  async deliver(inputs: PublishInput[]): Promise<void> {
    const items = inputs.flatMap((input) => {
      const item = input.event.item as (PushItem & { notify?: boolean; permalink?: string }) | undefined
      if (input.event.type !== "activity_added" || !item?.notify || input.audience === "team") return []
      return [{ teamId: input.teamId, userId: input.audience[0]!, item }]
    })
    if (items.length === 0) return
    const origin = new URL(items[0]!.item.permalink ?? "http://localhost").origin
    if (!(await loadVapid(this.env, origin))) return
    const now = Date.now()
    const present = items.filter((i) => !this.isActive(i.userId, now))
    if (present.length === 0) return
    const teamId = present[0]!.teamId
    const subs = await this.subscriptionsOf(teamId)
    const due = present.filter((i) => subs.get(i.userId)?.length && this.underCap(i.userId, now))
    if (due.length === 0) return
    const names = await this.names(due.map((i) => i.item))
    await this.send(
      teamId,
      due.flatMap((i) => {
        const message = itemPush(i.item, names)
        return subs.get(i.userId)!.map((sub) => ({ userId: i.userId, sub, message, origin }))
      }),
    )
  }

  /** Sends, then keeps D1 and the retries in step with what the services said. */
  private async send(teamId: string, outgoing: Outgoing[]): Promise<void> {
    const sql = this.ctx.storage.sql
    const outcomes = await Promise.all(
      outgoing.map(async (o): Promise<PushOutcome | undefined> => {
        const vapid = await loadVapid(this.env, o.origin)
        return vapid ? sendPush(vapid, o.sub as Target, o.message) : undefined
      }),
    )
    const used = new Set<string>()
    const gone = new Set<string>()
    let next: number | undefined
    outgoing.forEach((o, i) => {
      const outcome = outcomes[i]
      if (o.retry) sql.exec("DELETE FROM push_pending WHERE id = ?", o.retry.id)
      if (!outcome || outcome.misconfigured) return
      if (outcome.ok) used.add(o.sub.id)
      else if (outcome.gone) gone.add(o.sub.id)
      else if (outcome.transient) {
        const attempts = o.retry?.attempts ?? 0
        if (attempts >= PUSH_RETRY_DELAYS_MS.length) return
        const delay =
          outcome.retryAfterMs !== undefined
            ? Math.min(outcome.retryAfterMs, MAX_RETRY_AFTER_MS)
            : PUSH_RETRY_DELAYS_MS[attempts]!
        const at = Date.now() + delay
        sql.exec(
          `INSERT INTO push_pending (team_id, user_id, subscription_id, origin, message, attempts, due)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          teamId,
          o.userId,
          o.sub.id,
          o.origin,
          JSON.stringify(o.message),
          attempts + 1,
          at,
        )
        next = Math.min(next ?? at, at)
      } else {
        console.error("push refused", outcome.status, new URL(o.sub.endpoint).host)
      }
    })
    if (next !== undefined) await this.scheduleAlarm(next)
    if (gone.size) {
      // Forgotten here at once; D1 below.
      const subs = await this.subscriptionsOf(teamId)
      for (const [user, list] of subs)
        subs.set(
          user,
          list.filter((s) => !gone.has(s.id)),
        )
      for (const id of gone) sql.exec("DELETE FROM push_pending WHERE subscription_id = ?", id)
    }
    const db = this.env.DB
    const writes = [
      ...(used.size
        ? [
            db
              .prepare("UPDATE push_subscriptions SET last_used = ? WHERE id IN (SELECT value FROM json_each(?))")
              .bind(Math.floor(Date.now() / 1000), JSON.stringify([...used])),
          ]
        : []),
      // RFC 8030 §7.3: a 404 or 410 means the subscription is gone for good.
      ...(gone.size
        ? [
            db
              .prepare("DELETE FROM push_subscriptions WHERE id IN (SELECT value FROM json_each(?))")
              .bind(JSON.stringify([...gone])),
          ]
        : []),
    ]
    if (writes.length) await db.batch(writes)
  }

  /**
   * Sends the retries that are due (the hub's alarm calls this), each to its
   * subscription as it is now: none if it was removed or is no longer that
   * person's, and not while they're looking at the app or past their cap.
   */
  async retryDue(now: number): Promise<void> {
    const sql = this.ctx.storage.sql
    const rows = sql
      .exec<{
        id: number
        team_id: string
        user_id: string
        subscription_id: string
        origin: string
        message: string
        attempts: number
      }>(
        `SELECT id, team_id, user_id, subscription_id, origin, message, attempts FROM push_pending
         WHERE due <= ? ORDER BY id`,
        now,
      )
      .toArray()
    const byTeam = new Map<string, Outgoing[]>()
    for (const r of rows) {
      const sub = (await this.subscriptionsOf(r.team_id)).get(r.user_id)?.find((s) => s.id === r.subscription_id)
      if (!sub || this.isActive(r.user_id, now) || !this.underCap(r.user_id, now)) {
        sql.exec("DELETE FROM push_pending WHERE id = ?", r.id)
        continue
      }
      byTeam.set(r.team_id, [
        ...(byTeam.get(r.team_id) ?? []),
        {
          userId: r.user_id,
          sub,
          message: JSON.parse(r.message) as PushMessage,
          origin: r.origin,
          retry: { id: r.id, attempts: r.attempts },
        },
      ])
    }
    await Promise.all([...byTeam].map(([teamId, outgoing]) => this.send(teamId, outgoing)))
  }

  /** When the next retry is due, if any. */
  nextDue(): number | undefined {
    const due = this.ctx.storage.sql
      .exec<{ due: number | null }>("SELECT MIN(due) AS due FROM push_pending")
      .toArray()[0]?.due
    return due ?? undefined
  }
}
