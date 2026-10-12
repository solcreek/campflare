// A client for the Cloudflare Realtime SFU Connection API
// (https://rtc.live.cloudflare.com/v1). The App Secret stays here, on the
// Worker; browsers only ever see SDP and the ids we hand them.

export interface SessionDescription {
  type: "offer" | "answer"
  sdp: string
}

export interface TrackResult {
  location?: "local" | "remote"
  mid?: string
  trackName?: string
  sessionId?: string
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
    const data = (await res.json().catch(() => ({}))) as T & { errorCode?: string; errorDescription?: string }
    if (!res.ok || data.errorCode) throw new SfuError(operation, res.status, data.errorCode ?? `http_${res.status}`)
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
    async subscribe(sessionId: string, publications: { sessionId: string; trackName: string }[]) {
      const res = await call<TracksResponse>("tracks/new", "POST", `/sessions/${sessionId}/tracks/new`, {
        tracks: publications.map((p) => ({ location: "remote", ...p })),
      })
      return checkTracks("tracks/new", res)
    },

    async renegotiate(sessionId: string, answer: SessionDescription): Promise<void> {
      await call("renegotiate", "PUT", `/sessions/${sessionId}/renegotiate`, { sessionDescription: answer })
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
