import { DurableObject } from "cloudflare:workers"
import type { Env } from "./env"
import { ids } from "./api/ids"
import { appMentionOf, mentionedUsers } from "./app-events"

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
}

export interface PublishInput {
  teamId: string
  event: Record<string, unknown> & { type: string }
  /** Who may see it: user ids, or the whole team. */
  audience: string[] | "team"
  /** Client-state events (channel_marked and the like) that the Events API doesn't carry. */
  rtmOnly?: boolean
}

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

export class TeamHub extends DurableObject<Env> {
  private roundRobin = new Map<string, number>()
  /** Open polls, woken by each new event to look again. */
  private waiters = new Set<() => void>()

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
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
    // Socket Mode envelopes sent and not yet acknowledged.
    ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS unacked (
      envelope_id TEXT PRIMARY KEY,
      app_id TEXT NOT NULL,
      envelope TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      due INTEGER NOT NULL
    )`)
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

  /** Resends envelopes whose ack is overdue, as Slack does: retry_attempt counts up, retry_reason "timeout". */
  override async alarm(): Promise<void> {
    const now = Date.now()
    const due = this.ctx.storage.sql
      .exec<{ envelope_id: string; app_id: string; envelope: string; attempts: number }>(
        "SELECT envelope_id, app_id, envelope, attempts FROM unacked WHERE due <= ?",
        now,
      )
      .toArray()
    for (const row of due) {
      const attempts = row.attempts + 1
      if (attempts > MAX_RETRIES) {
        this.ctx.storage.sql.exec("DELETE FROM unacked WHERE envelope_id = ?", row.envelope_id)
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
    const next = this.ctx.storage.sql
      .exec<{ due: number | null }>("SELECT MIN(due) AS due FROM unacked")
      .toArray()[0]?.due
    if (next !== null && next !== undefined) await this.ctx.storage.setAlarm(next)
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
    }
    return new Response(null, { status: 101, webSocket: client })
  }

  async publish(input: PublishInput): Promise<number> {
    const { event, audience } = input
    const eventTs = (event.event_ts as string | undefined) ?? `${(Date.now() / 1000).toFixed(6)}`
    const body = { ...event, event_ts: eventTs }
    // Serialised once, for the log and every RTM link.
    const json = JSON.stringify(body)
    this.record(input, json)
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

    for (const [appId, links] of apps) {
      // Every link of an app has the same installer and bot.
      const { installerUserId, botUserId } = links[0]!.conn
      for (const payload of callbacksFor(input, body, { appId, installerUserId, botUserId })) {
        delivered += await this.deliver(this.nextLink(appId)!, appId, socketEnvelope(payload))
      }
    }
    return delivered
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
    let frame: { type?: string; id?: unknown; envelope_id?: string }
    try {
      frame = JSON.parse(message) as typeof frame
    } catch {
      return
    }
    // A Socket Mode ack: the envelope arrived, so it isn't sent again.
    if (frame.envelope_id) this.ctx.storage.sql.exec("DELETE FROM unacked WHERE envelope_id = ?", frame.envelope_id)
    if (frame.type === "ping") ws.send(JSON.stringify({ type: "pong", reply_to: frame.id }))
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
  if (
    bot &&
    body.user !== bot &&
    (audience === "team" || audience.includes(bot)) &&
    mentionedUsers(body).has(bot)
  ) {
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
