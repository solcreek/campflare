import exchanges from "./fixtures/sfu/exchanges.json"

// A Realtime SFU stand-in for offline tests, answering with responses
// recorded from the real API (tests/live, RECORD_FIXTURES=1) and keeping just
// enough state to behave like it: sessions exist once created, a track can be
// subscribed once published, an unknown session's renegotiation fails as the
// real one does (425 session_error).

type Exchange = { operation: string; status: number; response: Record<string, unknown> }
const recorded = exchanges as Exchange[]

function fixture(operation: string, match: (e: Exchange) => boolean = () => true): Exchange {
  const found = recorded.find((e) => e.operation === operation && match(e))
  if (!found) throw new Error(`no recorded ${operation}`)
  return structuredClone(found)
}

const PUBLISH = fixture(
  "POST /sessions/{id}/tracks/new",
  (e) => (e.response.sessionDescription as { type?: string })?.type === "answer",
)
const SUBSCRIBE = fixture(
  "POST /sessions/{id}/tracks/new",
  (e) => (e.response.sessionDescription as { type?: string })?.type === "offer",
)
const MISSING_TRACK = fixture("POST /sessions/{id}/tracks/new", (e) => !e.response.sessionDescription)
const UNKNOWN_SESSION = fixture("PUT /sessions/{id}/renegotiate", (e) => e.status === 425)

export interface FakeSfu {
  fetch: typeof fetch
  calls: { method: string; path: string; body?: Record<string, unknown> }[]
  sessions: Set<string>
  /** "sessionId/trackName" → mid, for what has been published. */
  published: Map<string, string>
  /** Make the next call to this operation ("POST /sessions/new"…) fail with this status and error code. */
  failNext(operation: string, status: number, errorCode: string): void
}

export function fakeSfu(): FakeSfu {
  const sessions = new Set<string>()
  const published = new Map<string, string>()
  const calls: FakeSfu["calls"] = []
  const failures = new Map<string, { status: number; errorCode: string }>()
  let counter = 0

  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input instanceof Request ? input.url : input))
    const method = init?.method ?? "GET"
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined
    const path = url.pathname.replace(/^\/v1\/apps\/[^/]+/, "")
    calls.push({ method, path, body })
    const operation = `${method} ${path.replace(/\/sessions\/[^/]+\//, "/sessions/{id}/")}`
    const failure = failures.get(operation)
    if (failure) {
      failures.delete(operation)
      return Response.json({ errorCode: failure.errorCode, errorDescription: "injected" }, { status: failure.status })
    }

    if (operation === "POST /sessions/new") {
      const sessionId = `fake-session-${++counter}`
      sessions.add(sessionId)
      return Response.json({ sessionId }, { status: 201 })
    }
    const sessionId = path.match(/\/sessions\/([^/]+)\//)?.[1] ?? ""
    if (!sessions.has(sessionId)) return Response.json(UNKNOWN_SESSION.response, { status: UNKNOWN_SESSION.status })
    const tracks = (body?.tracks ?? []) as { location?: string; mid?: string; trackName?: string; sessionId?: string }[]

    if (operation === "POST /sessions/{id}/tracks/new" && tracks[0]?.location === "local") {
      for (const t of tracks) published.set(`${sessionId}/${t.trackName}`, t.mid!)
      return Response.json({ ...PUBLISH.response, tracks: tracks.map((t) => ({ mid: t.mid, trackName: t.trackName })) })
    }
    if (operation === "POST /sessions/{id}/tracks/new") {
      const missing = tracks.filter((t) => !published.has(`${t.sessionId}/${t.trackName}`))
      if (missing.length) {
        const error = (MISSING_TRACK.response.tracks as Record<string, unknown>[])[0]!
        return Response.json({
          ...MISSING_TRACK.response,
          tracks: missing.map((t) => ({ ...error, trackName: t.trackName })),
        })
      }
      return Response.json({
        ...SUBSCRIBE.response,
        tracks: tracks.map((t, i) => ({ trackName: t.trackName, sessionId: t.sessionId, mid: String(i) })),
      })
    }
    if (operation === "PUT /sessions/{id}/renegotiate") return Response.json({})
    if (operation === "PUT /sessions/{id}/tracks/close") {
      return Response.json({ requiresImmediateRenegotiation: false, tracks: tracks.map((t) => ({ mid: t.mid })) })
    }
    return Response.json({ errorCode: "not_found", errorDescription: `fake SFU has no ${operation}` }, { status: 404 })
  }) as typeof fetch

  return {
    fetch: fetcher,
    calls,
    sessions,
    published,
    failNext: (operation, status, errorCode) => void failures.set(operation, { status, errorCode }),
  }
}
