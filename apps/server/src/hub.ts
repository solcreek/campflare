import { DurableObject } from "cloudflare:workers"
import type { Env } from "./env"
import { ids } from "./api/ids"
import { appMentionOf, mentionedUsers, subscribed } from "./app-events"
import type { AppRow } from "./db/rows"
import { disabledReason, disableDelivery, tellInstaller } from "./delivery-disabled"
import { createHealthTables, healthOf, recordAttempt, resetWindow, type DeliveryHealth } from "./delivery-health"
import { postSigned, REQUEST_TIMEOUT_MS, type PostResult } from "./request-url"
import { PushDelivery } from "./push/deliver"

// One TeamHub per workspace holds its live connections and fans events out.
//
// - Socket Mode (apps.connections.open, xapp-): each event is an `events_api`
//   envelope the client acknowledges. Like Slack, an app with several
//   connections gets each event on one of them, not all.
// - RTM (rtm.connect, xoxp-/xoxb-): the event objects themselves, to every
//   connection of a user who can see them. This is what a first-party UI uses.
//
// Connections use the hibernation API, so an idle workspace costs nothing.
//
// Every event is also kept in the hub's SQLite for a week, numbered in order,
// so a client without a live link (an agent, a script) can ask for what it
// missed since a cursor, and wait for the next ones: poll().

export interface Connection {
  kind: "socket" | "rtm"
  teamId: string
  /** socket: the app. */
  appId?: string
  /** Users whose view the connection receives: the user (rtm), or the app's installer and bot user (socket). */
  users: string[]
  /** socket: the bot user, for authorizations. */
  botUserId?: string
  installerUserId?: string
  connectedAt: number
  /** rtm: when its client last said it's active (a `campflare.active` frame), 0 once it said it isn't. */
  activeAt?: number
}

export interface PublishInput {
  teamId: string
  event: Record<string, unknown> & { type: string }
  /** Who may see it: user ids, or the whole team. */
  audience: string[] | "team"
  /** Client-state events (channel_marked and the like) that the Events API doesn't carry. */
  rtmOnly?: boolean
  /**
   * An app's ephemeral message to keep (its JSON), or forget (null), for a
   * while: it isn't stored in D1, but a click on its buttons needs it.
   */
  ephemeral?: { channelId: string; ts: string; userId: string; message: string | null }
}

/** An app's ephemeral message stays clickable this long. */
export const EPHEMERAL_TTL_MS = 24 * 60 * 60 * 1000

export interface PollInput {
  /** The user whose view to read. */
  user: string
  /** Events after this one; undefined starts from now. */
  cursor?: number
  limit: number
  /** How long to wait for an event when there is none yet. */
  waitMs: number
}

export interface PollResult {
  /** Each event as JSON: RPC return values must be serialisable, which `unknown` isn't. */
  events: { cursor: string; event: string }[]
  cursor: string
  hasMore: boolean
  error?: "invalid_cursor" | "cursor_expired"
}

/** One thing a seat publishes: a microphone, a camera. */
export interface HuddleTrack {
  name: string
  kind: "audio" | "video"
  /** Its transceiver in the publisher's connection. */
  mid: string
  /** Simulcast encodings it offers, best first by name (f, h, q). */
  rids?: string[]
}

export interface HuddleSeat {
  channel_id: string
  user_id: string
  /** The SFU session that publishes their tracks. */
  session_id: string
  tracks: HuddleTrack[]
  joined: number
}

type SeatRow = Omit<HuddleSeat, "tracks"> & { tracks: string }
const seatOf = (row: SeatRow): HuddleSeat => ({ ...row, tracks: JSON.parse(row.tracks) as HuddleTrack[] })

export const EVENT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000
/** Socket Mode: how long an envelope waits for its ack before it's sent again, and how often. */
export const ACK_TIMEOUT_MS = 3000
export const MAX_RETRIES = 3

/** A trigger_id works once, for 3 seconds, as Slack's do; spent or expired, it's remembered 10 minutes more. */
export const TRIGGER_TTL_MS = 3000
const TRIGGER_MEMORY_MS = 10 * 60 * 1000
/** Open views untouched this long are forgotten. */
export const VIEW_TTL_MS = 24 * 60 * 60 * 1000

/** A trigger_id handed to an app, and the person whose click (or submission) it came from. */
export interface TriggerGrant {
  id: string
  userId: string
}

/** Events API over HTTP: retries come 1 s, 1 min and 5 min after a failure, as Slack's do ("immediately", 1, 5). */
export const HTTP_RETRY_DELAYS_MS = [1_000, 60_000, 300_000]

type EventColumns = Pick<AppRow, "event_request_url" | "event_types">

/** An app with a Request URL or a subscription list. */
interface Subscriber {
  appId: string
  botUserId: string
  installerUserId: string
  secret: string
  url: string | null
  types?: string[]
}

export class TeamHub extends DurableObject<Env> {
  private roundRobin = new Map<string, number>()
  /** Open polls, woken by each new event to look again. */
  private waiters = new Set<() => void>()
  /** Web Push to people's devices (docs/push.md). */
  private push: PushDelivery

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    this.push = new PushDelivery(ctx, env, (at) => this.scheduleAlarm(at))
    ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS used_tickets (nonce TEXT PRIMARY KEY, expires INTEGER NOT NULL)")
    ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS events (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      at INTEGER NOT NULL,
      audience TEXT NOT NULL,
      rtm_only INTEGER NOT NULL,
      body TEXT NOT NULL
    )`)
    ctx.storage.sql.exec("CREATE INDEX IF NOT EXISTS events_at ON events (at)")
    // Huddles: who is in each conversation's call, publishing what (audio,
    // camera…), and which SFU sessions belong to whom.
    ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS huddle_seats (
      channel_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      tracks TEXT NOT NULL,
      joined INTEGER NOT NULL,
      PRIMARY KEY (channel_id, user_id)
    )`)
    ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS huddle_sessions (
      session_id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      channel_id TEXT NOT NULL,
      kind TEXT NOT NULL
    )`)
    // Deliveries not yet acknowledged: Socket Mode envelopes waiting for their
    // ack, and Events API POSTs to a Request URL that failed (keyed by event_id),
    // with why, for the retry's X-Slack-Retry-Reason.
    ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS unacked (
      envelope_id TEXT PRIMARY KEY,
      app_id TEXT NOT NULL,
      envelope TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      due INTEGER NOT NULL
    )`)
    const columns = ctx.storage.sql
      .exec<{ name: string }>("PRAGMA table_info(unacked)")
      .toArray()
      .map((c) => c.name)
    if (!columns.includes("transport")) {
      ctx.storage.sql.exec("ALTER TABLE unacked ADD COLUMN transport TEXT NOT NULL DEFAULT 'socket'")
      ctx.storage.sql.exec("ALTER TABLE unacked ADD COLUMN reason TEXT")
    }
    // Interactivity: how often each response_url (by its nonce) has been used, until it expires.
    ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS response_urls (
      nonce TEXT PRIMARY KEY,
      uses INTEGER NOT NULL,
      expires INTEGER NOT NULL
    )`)
    createHealthTables(ctx.storage.sql)
    // Apps' thread statuses (assistant.threads.setStatus): the latest event per
    // thread, until it expires, is cleared, or the app replies there, so an RTM
    // link that opens later gets it too (statusesFor()).
    ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS thread_statuses (
      channel_id TEXT NOT NULL,
      thread_ts TEXT NOT NULL,
      user_id TEXT NOT NULL,
      audience TEXT NOT NULL,
      body TEXT NOT NULL,
      expires INTEGER NOT NULL,
      PRIMARY KEY (channel_id, thread_ts)
    )`)
    // trigger_ids handed to apps with interactions: whom each opens a view for, until it's spent or expires.
    ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS triggers (
      id TEXT PRIMARY KEY,
      app_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      expires INTEGER NOT NULL,
      used INTEGER NOT NULL
    )`)
    // Open views (modals): each person's stack, bottom first.
    ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS views (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      app_id TEXT NOT NULL,
      external_id TEXT,
      position INTEGER NOT NULL,
      body TEXT NOT NULL,
      updated INTEGER NOT NULL
    )`)
    ctx.storage.sql.exec("CREATE INDEX IF NOT EXISTS views_user ON views (user_id, position)")
    // Apps' ephemeral messages with blocks, for a day: never in D1, but their buttons can be clicked.
    ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS ephemerals (
      channel_id TEXT NOT NULL,
      ts TEXT NOT NULL,
      user_id TEXT NOT NULL,
      message TEXT NOT NULL,
      expires INTEGER NOT NULL,
      PRIMARY KEY (channel_id, ts, user_id)
    )`)
  }

  /** Socket Mode `interactive` envelopes waiting for their ack, by envelope_id: called with the ack's payload. */
  private interactions = new Map<string, (response?: unknown) => void>()

  /**
   * Sends an interaction (block_actions, view_submission…), or a slash command
   * (`type` slash_commands, docs/commands-webhooks.md), to one of an app's
   * Socket Mode links and waits for its ack. Unlike events, it isn't kept or
   * sent again: as on Slack, an app that doesn't ack within 3 seconds shows
   * the person an error. Its trigger_id, if it carries one, is kept first
   * (whichever way the interaction then goes), so the app can open a view
   * with it. With `acceptsResponse` (view_submission), the ack's payload
   * comes back as JSON: the app's response_action.
   */
  async interact(
    appId: string,
    payload: Record<string, unknown>,
    {
      trigger,
      acceptsResponse = false,
      type = "interactive",
    }: { trigger?: TriggerGrant; acceptsResponse?: boolean; type?: "interactive" | "slash_commands" } = {},
  ): Promise<{ status: "acked" | "timeout" | "no_link"; response?: string }> {
    if (trigger) this.grantTrigger(appId, trigger)
    const ws = this.nextLink(appId)
    if (!ws) return { status: "no_link" }
    const envelopeId = ids.envelope()
    const acked = new Promise<{ response?: unknown } | undefined>((resolve) => {
      const timer = setTimeout(() => {
        this.interactions.delete(envelopeId)
        resolve(undefined)
      }, ACK_TIMEOUT_MS)
      this.interactions.set(envelopeId, (response) => {
        clearTimeout(timer)
        this.interactions.delete(envelopeId)
        resolve({ response })
      })
    })
    const sent = send(ws, {
      envelope_id: envelopeId,
      payload,
      type,
      accepts_response_payload: acceptsResponse,
    })
    if (!sent) {
      this.interactions.get(envelopeId)?.()
      return { status: "no_link" }
    }
    const ack = await acked
    if (!ack) return { status: "timeout" }
    return { status: "acked", ...(ack.response !== undefined ? { response: JSON.stringify(ack.response) } : {}) }
  }

  /** Keeps a trigger_id for TRIGGER_TTL_MS, for one views.open or views.push by the app it went to. */
  private grantTrigger(appId: string, grant: TriggerGrant) {
    const now = Date.now()
    // Spent and expired ones are kept a while, to tell an app which it was.
    this.ctx.storage.sql.exec("DELETE FROM triggers WHERE expires < ?", now - TRIGGER_MEMORY_MS)
    this.ctx.storage.sql.exec(
      "INSERT OR REPLACE INTO triggers (id, app_id, user_id, expires, used) VALUES (?, ?, ?, ?, 0)",
      grant.id,
      appId,
      grant.userId,
      now + TRIGGER_TTL_MS,
    )
  }

  /** Spends a trigger_id: the person it opens a view for, or why it can't. */
  async takeTrigger(id: string, appId: string): Promise<{ userId: string } | { error: string }> {
    const row = this.ctx.storage.sql
      .exec<{ app_id: string; user_id: string; expires: number; used: number }>(
        "SELECT app_id, user_id, expires, used FROM triggers WHERE id = ?",
        id,
      )
      .toArray()[0]
    if (!row || row.app_id !== appId) return { error: "invalid_trigger_id" }
    if (row.used) return { error: "exchanged_trigger_id" }
    if (row.expires < Date.now()) return { error: "expired_trigger_id" }
    this.ctx.storage.sql.exec("UPDATE triggers SET used = 1 WHERE id = ?", id)
    return { userId: row.user_id }
  }

  private keepEphemeral({ channelId, ts, userId, message }: NonNullable<PublishInput["ephemeral"]>) {
    const now = Date.now()
    this.ctx.storage.sql.exec("DELETE FROM ephemerals WHERE expires < ?", now)
    if (message === null) {
      this.ctx.storage.sql.exec(
        "DELETE FROM ephemerals WHERE channel_id = ? AND ts = ? AND user_id = ?",
        channelId,
        ts,
        userId,
      )
      return
    }
    this.ctx.storage.sql.exec(
      "INSERT OR REPLACE INTO ephemerals (channel_id, ts, user_id, message, expires) VALUES (?, ?, ?, ?, ?)",
      channelId,
      ts,
      userId,
      message,
      now + EPHEMERAL_TTL_MS,
    )
  }

  /** An app's ephemeral message to a person, as JSON, while it's kept. */
  async ephemeral(channelId: string, ts: string, userId: string): Promise<string | undefined> {
    return this.ctx.storage.sql
      .exec<{ message: string }>(
        "SELECT message FROM ephemerals WHERE channel_id = ? AND ts = ? AND user_id = ? AND expires >= ?",
        channelId,
        ts,
        userId,
        Date.now(),
      )
      .toArray()[0]?.message
  }

  /** A person's open views, bottom of the stack first, each as the JSON of a ViewRecord. */
  async viewStack(userId: string): Promise<string[]> {
    return this.ctx.storage.sql
      .exec<{ body: string }>("SELECT body FROM views WHERE user_id = ? ORDER BY position", userId)
      .toArray()
      .map((r) => r.body)
  }

  /** Whose stack holds a view, found by its id or (for its app) its external_id. */
  async findView(by: { id?: string; externalId?: string; appId?: string }): Promise<string | undefined> {
    const row = by.id
      ? this.ctx.storage.sql.exec<{ user_id: string }>("SELECT user_id FROM views WHERE id = ?", by.id).toArray()[0]
      : this.ctx.storage.sql
          .exec<{ user_id: string }>(
            "SELECT user_id FROM views WHERE external_id = ? AND app_id = ?",
            by.externalId ?? "",
            by.appId ?? "",
          )
          .toArray()[0]
    return row?.user_id
  }

  /**
   * Replaces a person's stack of views (empty closes them all) and tells
   * their clients, which show the top one: a `views_changed` event with the
   * stack, over RTM only. Views nobody touched for a day are forgotten.
   */
  async saveViews(teamId: string, userId: string, stack: string[], shown: string): Promise<void> {
    const now = Date.now()
    this.ctx.storage.sql.exec("DELETE FROM views WHERE user_id = ? OR updated < ?", userId, now - VIEW_TTL_MS)
    stack.forEach((body, position) => {
      const view = (JSON.parse(body) as { view: { id: string; app_id: string; external_id?: string } }).view
      this.ctx.storage.sql.exec(
        "INSERT INTO views (id, user_id, app_id, external_id, position, body, updated) VALUES (?, ?, ?, ?, ?, ?, ?)",
        view.id,
        userId,
        view.app_id,
        view.external_id || null,
        position,
        body,
        now,
      )
    })
    await this.publish({
      teamId,
      audience: [userId],
      rtmOnly: true,
      event: { type: "views_changed", views: JSON.parse(shown) as unknown },
    })
  }

  /** Counts one use of a response_url: false once it has had `max`. Expired ones are forgotten. */
  async useResponseUrl(nonce: string, expires: number, max: number): Promise<boolean> {
    const now = Date.now()
    this.ctx.storage.sql.exec("DELETE FROM response_urls WHERE expires < ?", now)
    const [row] = this.ctx.storage.sql
      .exec<{ uses: number }>(
        `INSERT INTO response_urls (nonce, uses, expires) VALUES (?, 1, ?)
         ON CONFLICT (nonce) DO UPDATE SET uses = uses + 1 RETURNING uses`,
        nonce,
        expires,
      )
      .toArray()
    return row!.uses <= max
  }

  /** The workspace's apps with event subscriptions, read from D1 once per hub lifetime and dropped on a change. */
  private subscribers?: { teamId: string; apps: Promise<Map<string, Subscriber>> }

  private subscribersOf(teamId: string): Promise<Map<string, Subscriber>> {
    if (this.subscribers?.teamId !== teamId) {
      const apps = this.env.DB.prepare(
        // A Request URL turned off for failing is no Request URL to deliver to.
        `SELECT id, bot_user_id, installer_user_id, signing_secret, event_types,
           CASE WHEN event_delivery_disabled_at IS NULL THEN event_request_url END AS event_request_url
         FROM apps WHERE team_id = ? AND (event_request_url IS NOT NULL OR event_types IS NOT NULL)`,
      )
        .bind(teamId)
        .all<Pick<AppRow, "id" | "bot_user_id" | "installer_user_id" | "signing_secret"> & EventColumns>()
        .then(
          ({ results }) =>
            new Map(
              results.map((r) => [
                r.id,
                {
                  appId: r.id,
                  botUserId: r.bot_user_id,
                  installerUserId: r.installer_user_id,
                  secret: r.signing_secret,
                  url: r.event_request_url,
                  types: r.event_types ? (JSON.parse(r.event_types) as string[]) : undefined,
                },
              ]),
            ),
        )
      // A failed read is tried again by the next event, not remembered.
      apps.catch(() => {
        if (this.subscribers?.apps === apps) this.subscribers = undefined
      })
      this.subscribers = { teamId, apps }
    }
    return this.subscribers.apps
  }

  /**
   * An app's Request URL, subscriptions or secret changed: read them again for
   * the next event. `newUrlOf` is an app given a (newly verified) Request URL,
   * whose failure count starts afresh; `origin`, the server's, for the DM
   * that tells its installer if it's turned off.
   */
  async subscriptionsChanged(newUrlOf?: string, origin?: string): Promise<void> {
    this.subscribers = undefined
    if (newUrlOf) resetWindow(this.ctx.storage.sql, newUrlOf)
    if (origin) await this.ctx.storage.put("origin", origin)
  }

  /**
   * The Request URL failed too often (see delivery-health.ts): turns HTTP
   * delivery off for the app, drops its pending retries and tells its installer.
   */
  private async turnOff(
    app: Subscriber & { url: string },
    totals: { attempts: number; failures: number },
    last: PostResult,
  ) {
    const off = await disableDelivery(this.env, app.appId, app.url, disabledReason(totals, last))
    if (!off) return
    this.subscribers = undefined
    this.ctx.storage.sql.exec("DELETE FROM unacked WHERE app_id = ? AND transport = 'http'", app.appId)
    resetWindow(this.ctx.storage.sql, app.appId)
    const origin = (await this.ctx.storage.get<string>("origin")) ?? "http://localhost"
    await tellInstaller(this.env, off, { origin, waitUntil: (p) => this.ctx.waitUntil(p) }).catch((error: unknown) =>
      console.error("telling the installer failed", app.appId, error),
    )
  }

  /** How an app's Request URL is doing, for campflare.apps.info. */
  async deliveryHealth(appId: string): Promise<DeliveryHealth> {
    return healthOf(this.ctx.storage.sql, appId)
  }

  /** The next connection of an app, in turn: Slack spreads an app's events across its links. */
  private nextLink(appId: string): WebSocket | undefined {
    const links = this.ctx.getWebSockets(`app:${appId}`)
    if (links.length === 0) return undefined
    const n = this.roundRobin.get(appId) ?? 0
    this.roundRobin.set(appId, n + 1)
    return links[n % links.length]
  }

  /** Sends an envelope and keeps it until acked, waking the alarm to resend it if it isn't. */
  private async deliver(ws: WebSocket, appId: string, envelope: { envelope_id: string }): Promise<number> {
    const due = Date.now() + ACK_TIMEOUT_MS
    this.ctx.storage.sql.exec(
      "INSERT INTO unacked (envelope_id, app_id, envelope, due) VALUES (?, ?, ?, ?)",
      envelope.envelope_id,
      appId,
      JSON.stringify(envelope),
      due,
    )
    await this.scheduleAlarm(due)
    return send(ws, envelope)
  }

  private async scheduleAlarm(at: number) {
    const current = await this.ctx.storage.getAlarm()
    if (current === null || current > at) await this.ctx.storage.setAlarm(at)
  }

  /**
   * POSTs an event_callback to an app's Request URL. It's kept (by event_id)
   * before the attempt, so a hub that stops mid-request still retries it.
   */
  private async post(app: Subscriber & { url: string }, payload: { event_id: string }): Promise<number> {
    const due = Date.now() + REQUEST_TIMEOUT_MS + HTTP_RETRY_DELAYS_MS[0]!
    const body = JSON.stringify(payload)
    this.ctx.storage.sql.exec(
      "INSERT INTO unacked (envelope_id, app_id, envelope, due, transport) VALUES (?, ?, ?, ?, 'http')",
      payload.event_id,
      app.appId,
      body,
      due,
    )
    await this.scheduleAlarm(due)
    return this.attempt(app, payload.event_id, body, 0)
  }

  /**
   * One attempt at a POST, counted towards the app's delivery health: done
   * when it's taken (2xx) or refused for good, else due again after a delay.
   */
  private async attempt(app: Subscriber & { url: string }, id: string, body: string, retry: number, reason?: string) {
    const res = await postSigned(app.url, app.secret, body, {
      retry: retry ? { num: retry, reason: reason ?? "unknown_error" } : undefined,
    })
    const tripped = recordAttempt(this.ctx.storage.sql, app.appId, res)
    if (tripped) {
      await this.turnOff(app, tripped, res)
      return 0
    }
    if (res.ok || res.noRetry || retry >= MAX_RETRIES) {
      this.ctx.storage.sql.exec("DELETE FROM unacked WHERE envelope_id = ?", id)
      return res.ok ? 1 : 0
    }
    const due = Date.now() + HTTP_RETRY_DELAYS_MS[retry]!
    this.ctx.storage.sql.exec("UPDATE unacked SET reason = ?, due = ? WHERE envelope_id = ?", res.reason, due, id)
    await this.scheduleAlarm(due)
    return 0
  }

  /** Retries a POST at the app's current Request URL; one removed since takes its pending events with it. */
  private async retryPost(
    row: { envelope_id: string; app_id: string; envelope: string; reason?: string | null },
    retry: number,
    now: number,
  ) {
    const teamId = (JSON.parse(row.envelope) as { team_id: string }).team_id
    const app = (await this.subscribersOf(teamId)).get(row.app_id)
    if (!app?.url) {
      this.ctx.storage.sql.exec("DELETE FROM unacked WHERE envelope_id = ?", row.envelope_id)
      return
    }
    // Due again in case this attempt never finishes; a finished one sets its own.
    const next = HTTP_RETRY_DELAYS_MS[retry] ?? HTTP_RETRY_DELAYS_MS.at(-1)!
    this.ctx.storage.sql.exec(
      "UPDATE unacked SET attempts = ?, due = ? WHERE envelope_id = ?",
      retry,
      now + REQUEST_TIMEOUT_MS + next,
      row.envelope_id,
    )
    await this.attempt({ ...app, url: app.url }, row.envelope_id, row.envelope, retry, row.reason ?? undefined)
  }

  /**
   * Resends what is overdue, as Slack does. Socket Mode: the envelope again
   * with retry_attempt counting up and retry_reason "timeout". HTTP: the same
   * event_callback with X-Slack-Retry-Num and X-Slack-Retry-Reason.
   */
  override async alarm(): Promise<void> {
    const now = Date.now()
    const due = this.ctx.storage.sql
      .exec<{
        envelope_id: string
        app_id: string
        envelope: string
        attempts: number
        transport: string
        reason: string | null
      }>("SELECT envelope_id, app_id, envelope, attempts, transport, reason FROM unacked WHERE due <= ?", now)
      .toArray()
    const posts: Promise<unknown>[] = []
    for (const row of due) {
      const attempts = row.attempts + 1
      if (attempts > MAX_RETRIES) {
        this.ctx.storage.sql.exec("DELETE FROM unacked WHERE envelope_id = ?", row.envelope_id)
        continue
      }
      if (row.transport === "http") {
        posts.push(this.retryPost(row, attempts, now))
        continue
      }
      const envelope = {
        ...(JSON.parse(row.envelope) as Record<string, unknown>),
        retry_attempt: attempts,
        retry_reason: "timeout",
      }
      this.ctx.storage.sql.exec(
        "UPDATE unacked SET attempts = ?, envelope = ?, due = ? WHERE envelope_id = ?",
        attempts,
        JSON.stringify(envelope),
        now + ACK_TIMEOUT_MS,
        row.envelope_id,
      )
      // Another link if the app has one: the first may be the one that's stuck.
      const ws = this.nextLink(row.app_id)
      if (ws) send(ws, envelope)
    }
    // Request URL retries and push retries go out together.
    await Promise.all([...posts, this.push.retryDue(now)])
    const unacked = this.ctx.storage.sql
      .exec<{ due: number | null }>("SELECT MIN(due) AS due FROM unacked")
      .toArray()[0]?.due
    const next = Math.min(unacked ?? Infinity, this.push.nextDue() ?? Infinity)
    if (next !== Infinity) await this.ctx.storage.setAlarm(next)
  }

  /** Someone's push subscriptions changed: read them again for the next activity item; removed ones' retries go. */
  async pushSubscriptionsChanged(removed: string[] = []): Promise<void> {
    this.push.forget(removed)
  }

  /** The last event number handed out (0 before the first). */
  private latestSeq(): number {
    const row = this.ctx.storage.sql
      .exec<{ seq: number }>("SELECT seq FROM sqlite_sequence WHERE name = 'events'")
      .toArray()[0]
    return row?.seq ?? 0
  }

  private record(input: PublishInput, body: string): number {
    const now = Date.now()
    const [row] = this.ctx.storage.sql
      .exec<{ seq: number }>(
        "INSERT INTO events (at, audience, rtm_only, body) VALUES (?, ?, ?, ?) RETURNING seq",
        now,
        JSON.stringify(input.audience),
        input.rtmOnly ? 1 : 0,
        body,
      )
      .toArray()
    const seq = row!.seq
    // Pruning now and then keeps the table a week long without a timer.
    if (seq % 100 === 0) this.ctx.storage.sql.exec("DELETE FROM events WHERE at < ?", now - EVENT_RETENTION_MS)
    for (const wake of this.waiters) wake()
    return seq
  }

  /** The events a user can see after `cursor`, waiting up to waitMs for one if there are none yet. */
  async poll(input: PollInput): Promise<PollResult> {
    const deadline = Date.now() + input.waitMs
    const latest = this.latestSeq()
    if (input.cursor === undefined) return { events: [], cursor: String(latest), hasMore: false }
    if (!Number.isInteger(input.cursor) || input.cursor < 0 || input.cursor > latest) {
      return { events: [], cursor: "", hasMore: false, error: "invalid_cursor" }
    }
    const oldest = this.ctx.storage.sql
      .exec<{ seq: number | null }>("SELECT MIN(seq) AS seq FROM events")
      .toArray()[0]?.seq
    // The next event the caller needs is gone: it would miss events without knowing.
    if (input.cursor < latest && (oldest === null || oldest === undefined || oldest > input.cursor + 1)) {
      return { events: [], cursor: "", hasMore: false, error: "cursor_expired" }
    }
    let cursor = input.cursor
    for (;;) {
      const scannedTo = this.latestSeq()
      const rows = this.ctx.storage.sql
        .exec<{ seq: number; body: string }>(
          `SELECT seq, body FROM events
           WHERE seq > ? AND (audience = '"team"' OR EXISTS (SELECT 1 FROM json_each(audience) WHERE value = ?))
           ORDER BY seq LIMIT ?`,
          cursor,
          input.user,
          input.limit,
        )
        .toArray()
      if (rows.length > 0) {
        const hasMore = rows.length === input.limit
        // A full page continues after its last event; a short one has seen everything up to now.
        const next = hasMore ? rows.at(-1)!.seq : scannedTo
        return {
          events: rows.map((r) => ({ cursor: String(r.seq), event: r.body })),
          cursor: String(next),
          hasMore,
        }
      }
      // Nothing for this user up to now: skip past others' events next time.
      cursor = scannedTo
      const remaining = deadline - Date.now()
      if (remaining <= 0) return { events: [], cursor: String(cursor), hasMore: false }
      await new Promise<void>((resolve) => {
        const wake = () => {
          clearTimeout(timer)
          this.waiters.delete(wake)
          resolve()
        }
        const timer = setTimeout(wake, remaining)
        this.waiters.add(wake)
      })
    }
  }

  /** WebSocket upgrades, already authenticated by the Worker, which passes the connection in a header. */
  override async fetch(request: Request): Promise<Response> {
    const conn = JSON.parse(request.headers.get("x-campflare-connection") ?? "null") as
      | (Connection & { nonce: string; expires: number })
      | null
    if (!conn || request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      return new Response("expected a websocket", { status: 426 })
    }
    // Tickets are single use: Slack's are too, and a leaked URL shouldn't open a second link.
    const now = Date.now()
    this.ctx.storage.sql.exec("DELETE FROM used_tickets WHERE expires < ?", now)
    const used = this.ctx.storage.sql.exec("SELECT 1 FROM used_tickets WHERE nonce = ?", conn.nonce).toArray()
    if (used.length > 0) return new Response("ticket already used", { status: 401 })
    this.ctx.storage.sql.exec("INSERT INTO used_tickets (nonce, expires) VALUES (?, ?)", conn.nonce, conn.expires)

    const { nonce: _nonce, expires: _expires, ...connection } = conn
    const pair = new WebSocketPair()
    const [client, server] = [pair[0], pair[1]]
    const tags = connection.kind === "socket" ? [`app:${connection.appId}`] : [`user:${connection.users[0]}`]
    this.ctx.acceptWebSocket(server, tags)
    server.serializeAttachment({ ...connection, connectedAt: now } satisfies Connection)
    if (connection.kind === "socket") {
      server.send(
        JSON.stringify({
          type: "hello",
          num_connections: this.ctx.getWebSockets(`app:${connection.appId}`).length,
          debug_info: { host: "campflare", build_number: 1, approximate_connection_time: 18060 },
          connection_info: { app_id: connection.appId },
        }),
      )
    } else {
      server.send(JSON.stringify({ type: "hello" }))
      // What a client that was there would be showing: apps' statuses in threads.
      for (const body of this.statusesFor(connection.users[0]!, now)) send(server, body)
    }
    return new Response(null, { status: 101, webSocket: client })
  }

  /** Several events, in order, in one RPC: each person's own activity item, say. */
  async publishEach(inputs: PublishInput[]): Promise<number> {
    let delivered = 0
    for (const input of inputs) delivered += await this.send(input)
    // After every link has them: activity items that notify go to people's devices.
    await this.pushItems(inputs)
    return delivered
  }

  async publish(input: PublishInput): Promise<number> {
    const delivered = await this.send(input)
    await this.pushItems([input])
    return delivered
  }

  /** Push failing must not fail publishing: the events went out. */
  private async pushItems(inputs: PublishInput[]) {
    await this.push.deliver(inputs).catch((error: unknown) => console.error("push failed", error))
  }

  private async send(input: PublishInput): Promise<number> {
    const { event, audience } = input
    if (input.ephemeral) this.keepEphemeral(input.ephemeral)
    const eventTs = (event.event_ts as string | undefined) ?? `${(Date.now() / 1000).toFixed(6)}`
    const body = { ...event, event_ts: eventTs }
    // Serialised once, for the log and every RTM link.
    const json = JSON.stringify(body)
    this.record(input, json)
    this.keepStatus(input, json)
    const members = audience === "team" ? undefined : new Set(audience)
    const sees = (users: string[]) => !members || users.some((u) => members.has(u))
    let delivered = 0

    const apps = new Map<string, { ws: WebSocket; conn: Connection }[]>()
    for (const ws of this.ctx.getWebSockets()) {
      const conn = ws.deserializeAttachment() as Connection | null
      if (!conn || !sees(conn.users)) continue
      if (conn.kind === "rtm") {
        delivered += send(ws, json)
      } else if (!input.rtmOnly && conn.appId) {
        apps.set(conn.appId, [...(apps.get(conn.appId) ?? []), { ws, conn }])
      }
    }

    if (input.rtmOnly) return delivered

    const subscribers = await this.subscribersOf(input.teamId)
    for (const [appId, links] of apps) {
      // Every link of an app has the same installer and bot.
      const { installerUserId, botUserId } = links[0]!.conn
      const types = subscribers.get(appId)?.types
      for (const payload of callbacksFor(input, body, { appId, installerUserId, botUserId })) {
        if (!subscribed(types, payload.event)) continue
        delivered += await this.deliver(this.nextLink(appId)!, appId, socketEnvelope(payload))
      }
    }

    // The Events API over HTTP, for apps with a Request URL and no Socket Mode link: as on Slack,
    // a connected app gets its events over the socket instead.
    const posts: Promise<number>[] = []
    for (const app of subscribers.values()) {
      const { url } = app
      if (!url || this.ctx.getWebSockets(`app:${app.appId}`).length > 0) continue
      if (!sees([app.installerUserId, app.botUserId])) continue
      for (const payload of callbacksFor(input, body, app)) {
        if (subscribed(app.types, payload.event)) posts.push(this.post({ ...app, url }, payload))
      }
    }
    for (const n of await Promise.all(posts)) delivered += n
    return delivered
  }

  /**
   * Keeps the thread statuses statusesFor() replays in step with the events
   * clients clear theirs on: a status replaces the thread's, an empty one
   * clears it, and so does a new message in the thread from the status's app.
   */
  private keepStatus(input: PublishInput, json: string) {
    const { event } = input
    const sql = this.ctx.storage.sql
    if (event.type === "assistant_thread_status_changed") {
      const expiresIn = typeof event.expires_in === "number" ? event.expires_in : 0
      if (!event.status || expiresIn <= 0) {
        sql.exec("DELETE FROM thread_statuses WHERE channel_id = ? AND thread_ts = ?", event.channel, event.thread_ts)
        return
      }
      sql.exec(
        `INSERT OR REPLACE INTO thread_statuses (channel_id, thread_ts, user_id, audience, body, expires)
         VALUES (?, ?, ?, ?, ?, ?)`,
        event.channel,
        event.thread_ts,
        event.user,
        JSON.stringify(input.audience),
        json,
        Date.now() + expiresIn * 1000,
      )
    } else if (event.type === "message" && event.thread_ts && event.user) {
      if (event.subtype === "message_changed" || event.subtype === "message_deleted") return
      sql.exec(
        "DELETE FROM thread_statuses WHERE channel_id = ? AND thread_ts = ? AND user_id = ?",
        event.channel,
        event.thread_ts,
        event.user,
      )
    }
  }

  /** The thread statuses a user can see that are still showing, as their events. Expired ones are forgotten. */
  private statusesFor(user: string, now: number): string[] {
    const sql = this.ctx.storage.sql
    sql.exec("DELETE FROM thread_statuses WHERE expires <= ?", now)
    return sql
      .exec<{ body: string }>(
        `SELECT body FROM thread_statuses
         WHERE audience = '"team"' OR EXISTS (SELECT 1 FROM json_each(audience) WHERE value = ?)
         ORDER BY expires`,
        user,
      )
      .toArray()
      .map((r) => r.body)
  }

  /** Huddles: someone starts publishing in a conversation's call (replacing their earlier seat, if any). */
  async huddleJoin(seat: HuddleSeat): Promise<{ previous?: HuddleSeat; others: HuddleSeat[] }> {
    const previous = await this.huddleSeat(seat.channel_id, seat.user_id)
    this.ctx.storage.sql.exec(
      "INSERT OR REPLACE INTO huddle_seats (channel_id, user_id, session_id, tracks, joined) VALUES (?, ?, ?, ?, ?)",
      seat.channel_id,
      seat.user_id,
      seat.session_id,
      JSON.stringify(seat.tracks),
      seat.joined,
    )
    await this.huddleOwn(seat.session_id, seat.user_id, seat.channel_id, "publish")
    const others = (await this.huddleList(seat.channel_id)).filter((o) => o.user_id !== seat.user_id)
    return { ...(previous ? { previous } : {}), others }
  }

  /** Replaces what a seat publishes (a camera turned on or off). */
  async huddleSetTracks(channelId: string, userId: string, tracks: HuddleTrack[]): Promise<HuddleSeat | undefined> {
    this.ctx.storage.sql.exec(
      "UPDATE huddle_seats SET tracks = ? WHERE channel_id = ? AND user_id = ?",
      JSON.stringify(tracks),
      channelId,
      userId,
    )
    return this.huddleSeat(channelId, userId)
  }

  async huddleLeave(channelId: string, userId: string): Promise<HuddleSeat | undefined> {
    const seat = await this.huddleSeat(channelId, userId)
    this.ctx.storage.sql.exec("DELETE FROM huddle_seats WHERE channel_id = ? AND user_id = ?", channelId, userId)
    this.ctx.storage.sql.exec("DELETE FROM huddle_sessions WHERE channel_id = ? AND user_id = ?", channelId, userId)
    return seat
  }

  async huddleList(channelId: string): Promise<HuddleSeat[]> {
    return this.ctx.storage.sql
      .exec<SeatRow & Record<string, SqlStorageValue>>(
        "SELECT * FROM huddle_seats WHERE channel_id = ? ORDER BY joined",
        channelId,
      )
      .toArray()
      .map(seatOf)
  }

  async huddleSeat(channelId: string, userId: string): Promise<HuddleSeat | undefined> {
    const row = this.ctx.storage.sql
      .exec<SeatRow & Record<string, SqlStorageValue>>(
        "SELECT * FROM huddle_seats WHERE channel_id = ? AND user_id = ?",
        channelId,
        userId,
      )
      .toArray()[0]
    return row ? seatOf(row) : undefined
  }

  /** Records which user may act on an SFU session. */
  async huddleOwn(sessionId: string, userId: string, channelId: string, kind: "publish" | "receive"): Promise<void> {
    this.ctx.storage.sql.exec(
      "INSERT OR REPLACE INTO huddle_sessions (session_id, user_id, channel_id, kind) VALUES (?, ?, ?, ?)",
      sessionId,
      userId,
      channelId,
      kind,
    )
  }

  async huddleSession(sessionId: string): Promise<{ user_id: string; channel_id: string; kind: string } | undefined> {
    return this.ctx.storage.sql
      .exec<{ user_id: string; channel_id: string; kind: string }>(
        "SELECT user_id, channel_id, kind FROM huddle_sessions WHERE session_id = ?",
        sessionId,
      )
      .toArray()[0]
  }

  /** Connections live now, for users.getPresence. */
  async online(userIds: string[]): Promise<string[]> {
    return userIds.filter((u) => this.ctx.getWebSockets(`user:${u}`).length > 0)
  }

  override async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message !== "string") return
    let frame: { type?: string; id?: unknown; envelope_id?: string; payload?: unknown; active?: unknown }
    try {
      frame = JSON.parse(message) as typeof frame
    } catch {
      return
    }
    // A Socket Mode ack: the envelope arrived, so it isn't sent again; an interaction's clicker hears it was taken.
    if (frame.envelope_id) {
      this.ctx.storage.sql.exec("DELETE FROM unacked WHERE envelope_id = ?", frame.envelope_id)
      this.interactions.get(frame.envelope_id)?.(frame.payload)
    }
    if (frame.type === "ping") ws.send(JSON.stringify({ type: "pong", reply_to: frame.id }))
    // A client saying whether its person is looking at it: no push while they are (docs/push.md).
    if (frame.type === "campflare.active") {
      const conn = ws.deserializeAttachment() as Connection | null
      if (conn?.kind === "rtm") ws.serializeAttachment({ ...conn, activeAt: frame.active === true ? Date.now() : 0 })
    }
  }

  override async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    try {
      ws.close(code === 1005 ? 1000 : code, reason)
    } catch {
      // already closed
    }
  }
}

interface AppView {
  appId: string
  installerUserId?: string
  botUserId?: string
}

/**
 * What one app receives for a published event, as event_callbacks: the event,
 * and app_mention when it's a new message mentioning the app's bot user in a
 * conversation the bot is in (never for the bot's own message).
 */
function callbacksFor(input: PublishInput, body: Record<string, unknown>, app: AppView) {
  const { teamId, audience } = input
  // Authorized as the installer when the event is theirs to see, else as the bot.
  const asInstaller = app.installerUserId && (audience === "team" || audience.includes(app.installerUserId))
  const callbacks = [
    callbackOf(teamId, app.appId, body, {
      userId: (asInstaller ? app.installerUserId : app.botUserId) ?? "",
      isBot: !asInstaller,
    }),
  ]
  const bot = app.botUserId
  if (bot && body.user !== bot && (audience === "team" || audience.includes(bot)) && mentionedUsers(body).has(bot)) {
    callbacks.push(callbackOf(teamId, app.appId, appMentionOf(body), { userId: bot, isBot: true }))
  }
  return callbacks
}

/** Slack's event_callback: an event as the Events API wraps it for one app. */
function callbackOf(
  teamId: string,
  appId: string,
  event: Record<string, unknown>,
  authorized: { userId: string; isBot: boolean },
) {
  return {
    token: "",
    team_id: teamId,
    context_team_id: teamId,
    context_enterprise_id: null,
    api_app_id: appId,
    event,
    type: "event_callback",
    event_id: ids.event(),
    event_time: Math.floor(Number(event.event_ts)),
    authorizations: [
      {
        enterprise_id: null,
        team_id: teamId,
        user_id: authorized.userId,
        is_bot: authorized.isBot,
        is_enterprise_install: false,
      },
    ],
    is_ext_shared_channel: false,
  }
}

/** A Socket Mode envelope around an event_callback. */
function socketEnvelope(payload: ReturnType<typeof callbackOf>) {
  return {
    envelope_id: ids.envelope(),
    type: "events_api",
    accepts_response_payload: false,
    retry_attempt: 0,
    retry_reason: "",
    payload,
  }
}

function send(ws: WebSocket, value: unknown): number {
  try {
    ws.send(typeof value === "string" ? value : JSON.stringify(value))
    return 1
  } catch {
    return 0
  }
}
