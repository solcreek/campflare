import { DurableObject } from "cloudflare:workers"
import type { Env } from "./env"
import { ids } from "./api/ids"

// One TeamHub per workspace holds its live connections and fans events out.
//
// - Socket Mode (apps.connections.open, xapp-): each event is an `events_api`
//   envelope the client acknowledges. Like Slack, an app with several
//   connections gets each event on one of them, not all.
// - RTM (rtm.connect, xoxp-/xoxb-): the event objects themselves, to every
//   connection of a user who can see them. This is what a first-party UI uses.
//
// Connections use the hibernation API, so an idle workspace costs nothing.

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

export class TeamHub extends DurableObject<Env> {
  private roundRobin = new Map<string, number>()

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS used_tickets (nonce TEXT PRIMARY KEY, expires INTEGER NOT NULL)")
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
    const sees = (users: string[]) => audience === "team" || users.some((u) => audience.includes(u))
    let delivered = 0

    const apps = new Map<string, { ws: WebSocket; conn: Connection }[]>()
    for (const ws of this.ctx.getWebSockets()) {
      const conn = ws.deserializeAttachment() as Connection | null
      if (!conn || !sees(conn.users)) continue
      if (conn.kind === "rtm") {
        delivered += send(ws, body)
      } else if (!input.rtmOnly && conn.appId) {
        apps.set(conn.appId, [...(apps.get(conn.appId) ?? []), { ws, conn }])
      }
    }

    for (const [appId, links] of apps) {
      const n = this.roundRobin.get(appId) ?? 0
      this.roundRobin.set(appId, n + 1)
      const { ws, conn } = links[n % links.length]!
      // Authorized as the installer when the event is theirs to see, else as the bot.
      const asInstaller = conn.installerUserId && (audience === "team" || audience.includes(conn.installerUserId))
      const envelope = {
        envelope_id: ids.envelope(),
        type: "events_api",
        accepts_response_payload: false,
        retry_attempt: 0,
        retry_reason: "",
        payload: {
          token: "",
          team_id: input.teamId,
          context_team_id: input.teamId,
          context_enterprise_id: null,
          api_app_id: appId,
          event: body,
          type: "event_callback",
          event_id: ids.event(),
          event_time: Math.floor(Number(eventTs)),
          authorizations: [
            {
              enterprise_id: null,
              team_id: input.teamId,
              user_id: asInstaller ? conn.installerUserId : conn.botUserId,
              is_bot: !asInstaller,
              is_enterprise_install: false,
            },
          ],
          is_ext_shared_channel: false,
        },
      }
      delivered += send(ws, envelope)
    }
    return delivered
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
    // Socket Mode acks ({ envelope_id }) need no answer: events aren't redelivered yet.
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

function send(ws: WebSocket, value: unknown): number {
  try {
    ws.send(JSON.stringify(value))
    return 1
  } catch {
    return 0
  }
}
