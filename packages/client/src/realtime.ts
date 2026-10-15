import type { Client } from "./web"

// Live events over a WebSocket.
//
// - Socket Mode (`apps.connections.open`, app token): envelopes, each acked.
//   Works against Slack and Campflare.
// - RTM (`rtm.connect`, user or bot token): the events themselves. Campflare's
//   native stream for its own clients.
//
// Both reconnect with backoff when the link drops, and Socket Mode follows
// the server's "disconnect" by opening the next link before closing the old.

export interface RealtimeEvent {
  type: string
  [key: string]: unknown
}

export interface ListenOptions {
  /** A client whose token suits the mode: an app token for socket, a user or bot token for rtm. */
  client: Client
  mode: "socket" | "rtm"
  onEvent: (event: RealtimeEvent) => void
  onStatus?: (status: "connecting" | "connected" | "disconnected", detail?: string) => void
  WebSocket?: typeof globalThis.WebSocket
  minDelayMs?: number
  maxDelayMs?: number
}

export interface Listener {
  close(): void
  /**
   * Sends a frame on the live link (a Campflare client's `campflare.active`, say);
   * false when there's none right now. Nothing is queued: resend on the next "connected".
   */
  send(frame: Record<string, unknown>): boolean
}

interface Frame {
  type?: string
  envelope_id?: string
  payload?: { event?: RealtimeEvent }
}

export function listen(options: ListenOptions): Listener {
  const WS = options.WebSocket ?? globalThis.WebSocket
  const minDelay = options.minDelayMs ?? 1000
  const maxDelay = options.maxDelayMs ?? 30_000
  let delay = minDelay
  let closed = false
  let socket: WebSocket | undefined
  /** The link said hello and hasn't closed since. */
  let connected = false
  let timer: ReturnType<typeof setTimeout> | undefined

  const status = (s: "connecting" | "connected" | "disconnected", detail?: string) => options.onStatus?.(s, detail)

  async function openUrl(): Promise<string> {
    const method = options.mode === "socket" ? "apps.connections.open" : "rtm.connect"
    const res = await options.client.call<{ ok: boolean; url: string }>(method)
    return res.url
  }

  function retry(detail?: string) {
    if (closed || timer) return
    status("disconnected", detail)
    timer = setTimeout(() => {
      timer = undefined
      void connect()
    }, delay)
    delay = Math.min(delay * 2, maxDelay)
  }

  function handle(ws: WebSocket, frame: Frame) {
    if (frame.envelope_id) ws.send(JSON.stringify({ envelope_id: frame.envelope_id }))
    if (frame.type === "hello") {
      delay = minDelay
      if (socket && socket !== ws) {
        // A refresh: the new link is live, so retire the old one.
        const old = socket
        socket = ws
        retired.add(old)
        old.close()
        return
      }
      socket = ws
      connected = true
      status("connected")
    } else if (frame.type === "disconnect" && options.mode === "socket") {
      void openUrl()
        .then((url) => {
          if (!closed) open(url)
        })
        .catch(() => ws.close())
    } else if (frame.type === "events_api") {
      if (frame.payload?.event) options.onEvent(frame.payload.event)
    } else if (options.mode === "rtm" && frame.type && frame.type !== "pong") {
      options.onEvent(frame as RealtimeEvent)
    }
  }

  const retired = new Set<WebSocket>()

  function open(url: string) {
    const ws = new WS(url)
    ws.addEventListener("message", (e) => {
      try {
        handle(ws, JSON.parse(String(e.data)) as Frame)
      } catch {
        // A malformed frame shouldn't take the link down.
      }
    })
    ws.addEventListener("close", () => {
      if (retired.delete(ws)) return
      if (socket && ws !== socket) return // a replacement that never said hello
      socket = undefined
      connected = false
      retry()
    })
    if (!socket) socket = ws
  }

  async function connect() {
    if (closed) return
    status("connecting")
    try {
      const url = await openUrl()
      if (!closed) open(url)
    } catch (error) {
      retry(error instanceof Error ? error.message : String(error))
    }
  }

  void connect()
  return {
    close() {
      closed = true
      clearTimeout(timer)
      socket?.close()
    },
    send(frame) {
      if (!connected || !socket) return false
      try {
        socket.send(JSON.stringify(frame))
        return true
      } catch {
        return false
      }
    },
  }
}
