// A client for the Cloudflare Realtime SFU Connection API
// (https://rtc.live.cloudflare.com/v1). The App Secret stays here, on the
// Worker; browsers only ever see SDP and the ids we hand them.

export interface SessionDescription {
  type: "offer" | "answer"
  sdp: string
}

/** Which simulcast encoding a subscriber gets, and what the SFU may fall back to. */
export interface SimulcastPreference {
  preferredRid: string
  priorityOrdering?: "none" | "asciibetical"
  ridNotAvailable?: "none" | "asciibetical"
}

/** A publication to receive, optionally at a simulcast layer. */
export interface Publication {
  sessionId: string
  trackName: string
  simulcast?: SimulcastPreference
}

export interface TrackResult {
  location?: "local" | "remote"
  mid?: string
  trackName?: string
  sessionId?: string
  errorCode?: string
  errorDescription?: string
}

export interface AdapterResult {
  adapterId?: string
  trackName?: string
  endpoint?: string
  errorCode?: string
  errorDescription?: string
}

export interface TracksResponse {
  sessionDescription?: SessionDescription
  requiresImmediateRenegotiation?: boolean
  tracks?: TrackResult[]
  errorCode?: string
  errorDescription?: string
}

export class SfuError extends Error {
  constructor(
    readonly operation: string,
    readonly status: number,
    readonly code: string,
  ) {
    super(`SFU ${operation} failed (${status}): ${code}`)
  }
}

/** Per-track errors arrive inside a successful response: surface the first. */
function checkTracks(operation: string, res: TracksResponse): TracksResponse {
  const failed = res.tracks?.find((t) => t.errorCode)
  if (failed) throw new SfuError(operation, 200, failed.errorCode!)
  return res
}

export interface SfuOptions {
  appId: string
  appSecret: string
  fetch?: typeof fetch
  baseUrl?: string
}

export function createSfu(options: SfuOptions) {
  const base = `${options.baseUrl ?? "https://rtc.live.cloudflare.com/v1"}/apps/${options.appId}`
  const fetcher = options.fetch ?? ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, init))

  async function call<T>(operation: string, method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetcher(`${base}${path}`, {
      method,
      headers: { authorization: `Bearer ${options.appSecret}`, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    const data = (await res.json().catch(() => ({}))) as T & {
      errorCode?: string
      errorDescription?: string
      tracks?: { errorCode?: string }[]
    }
    if (!res.ok || data.errorCode) {
      // A batch where every entry failed (503) names the cause per entry: report the first.
      const code = data.errorCode ?? data.tracks?.find((t) => t.errorCode)?.errorCode ?? `http_${res.status}`
      throw new SfuError(operation, res.status, code)
    }
    return data
  }

  return {
    /** A session: one browser PeerConnection to the SFU. */
    async newSession(): Promise<string> {
      return (await call<{ sessionId: string }>("sessions/new", "POST", "/sessions/new")).sessionId
    },

    /** Publishes the browser's local tracks, given its offer; the answer completes the exchange. */
    async publish(sessionId: string, offer: SessionDescription, tracks: { mid: string; trackName: string }[]) {
      const res = await call<TracksResponse>("tracks/new", "POST", `/sessions/${sessionId}/tracks/new`, {
        sessionDescription: offer,
        tracks: tracks.map((t) => ({ location: "local", ...t })),
      })
      return checkTracks("tracks/new", res)
    },

    /** Subscribes this session to others' publications; the SFU answers with an offer for the browser. */
    async subscribe(sessionId: string, publications: Publication[]) {
      const res = await call<TracksResponse>("tracks/new", "POST", `/sessions/${sessionId}/tracks/new`, {
        tracks: publications.map((p) => ({ location: "remote", ...p })),
      })
      return checkTracks("tracks/new", res)
    },

    /** Changes existing subscriptions in place (by receiving mid): another simulcast layer, say. No negotiation. */
    async update(sessionId: string, subscriptions: (Publication & { mid: string })[]) {
      const res = await call<TracksResponse>("tracks/update", "PUT", `/sessions/${sessionId}/tracks/update`, {
        tracks: subscriptions.map((t) => ({ location: "remote", ...t })),
      })
      return checkTracks("tracks/update", res)
    },

    async renegotiate(sessionId: string, answer: SessionDescription): Promise<void> {
      await call("renegotiate", "PUT", `/sessions/${sessionId}/renegotiate`, { sessionDescription: answer })
    },

    /**
     * Streams publications to WebSocket endpoints as 48 kHz stereo PCM (the
     * SFU connects out to each endpoint). One to four per request; each
     * result has its own adapterId or error, and the batch fails only when
     * all do (503).
     */
    async streamToWebSocket(entries: { sessionId: string; trackName: string; endpoint: string }[]) {
      const res = await call<{ tracks?: AdapterResult[] }>(
        "adapters/websocket/new",
        "POST",
        "/adapters/websocket/new",
        {
          tracks: entries.map((e) => ({ location: "remote", outputCodec: "pcm", ...e })),
        },
      )
      return res.tracks ?? []
    },

    /** Closes adapters; closing one already closed is fine. */
    async closeAdapters(adapterIds: string[]): Promise<AdapterResult[]> {
      if (adapterIds.length === 0) return []
      const res = await call<{ tracks?: AdapterResult[] }>(
        "adapters/websocket/close",
        "POST",
        "/adapters/websocket/close",
        {
          tracks: adapterIds.map((adapterId) => ({ adapterId })),
        },
      )
      return res.tracks ?? []
    },

    /** Stops forwarding without negotiation: for cleaning up after someone who has left. */
    async forceClose(sessionId: string, mids: string[]): Promise<void> {
      if (mids.length === 0) return
      await call("tracks/close", "PUT", `/sessions/${sessionId}/tracks/close`, {
        tracks: mids.map((mid) => ({ mid })),
        force: true,
      })
    },
  }
}

export type Sfu = ReturnType<typeof createSfu>

/** What a browser's RTCPeerConnection takes as one ICE server. */
export interface IceServer {
  urls: string | string[]
  username?: string
  credential?: string
}

/** ICE servers for browsers: Cloudflare STUN, plus short-lived TURN credentials when a TURN key is configured. */
export async function iceServers(
  env: { REALTIME_TURN_KEY_ID?: string; REALTIME_TURN_KEY_TOKEN?: string },
  fetcher: typeof fetch = (input, init) => fetch(input, init),
): Promise<IceServer[]> {
  const stun: IceServer[] = [{ urls: ["stun:stun.cloudflare.com:3478"] }]
  if (!env.REALTIME_TURN_KEY_ID || !env.REALTIME_TURN_KEY_TOKEN) return stun
  const res = await fetcher(
    `https://rtc.live.cloudflare.com/v1/turn/keys/${env.REALTIME_TURN_KEY_ID}/credentials/generate-ice-servers`,
    {
      method: "POST",
      headers: { authorization: `Bearer ${env.REALTIME_TURN_KEY_TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ ttl: 3600 }),
    },
  )
  if (!res.ok) return stun
  const body = (await res.json()) as { iceServers?: IceServer[] }
  // Port 53 is blocked by browsers and only delays ICE: leave it out.
  return (body.iceServers ?? stun).map((server) => ({
    ...server,
    urls: (Array.isArray(server.urls) ? server.urls : [server.urls]).filter((u: string) => !/:53(\?|$)/.test(u)),
  }))
}
