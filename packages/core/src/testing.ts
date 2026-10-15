import { createClient, type Client, type Fetch } from "@campflare/client"

// Test doubles for apps built on @campflare/core (import "@campflare/core/testing"):
// a scripted Web API and a WebSocket the test drives by hand.

export type Handler = (args: Record<string, string>) => Record<string, unknown> | Error

export interface FakeApi {
  client: Client
  /** The server as a fetch, for code that makes its own client. */
  fetch: Fetch
  calls: { method: string; args: Record<string, string> }[]
  handlers: Record<string, Handler>
  /**
   * Everything outside the Web API, by URL: GET serves the body (404 if absent; an
   * Error fails the request), POST (an upload URL) stores its body here.
   */
  files: Record<string, BodyInit | Error>
  /** Each request outside the Web API, in order. */
  fileRequests: { url: string; method: string; headers: Record<string, string> }[]
}

export function fakeApi(handlers: Record<string, Handler>): FakeApi {
  const calls: FakeApi["calls"] = []
  const fetch: Fetch = async (input, init) => {
    if (!String(input).includes("/api/")) return serveFile(String(input), init)
    const method = String(input).split("/api/")[1]!
    const args = Object.fromEntries(new URLSearchParams(String(init?.body ?? "")))
    calls.push({ method, args })
    const handler = api.handlers[method]
    if (!handler) return Response.json({ ok: false, error: "unknown_method" })
    const result = handler(args)
    if (result instanceof Error) return Response.json({ ok: false, error: result.message })
    return Response.json({ ok: true, ...result })
  }
  async function serveFile(url: string, init?: RequestInit) {
    const method = init?.method ?? "GET"
    api.fileRequests.push({ url, method, headers: { ...(init?.headers as Record<string, string>) } })
    if (method === "POST") {
      api.files[url] = await new Response(init?.body).arrayBuffer()
      return new Response("OK")
    }
    const body = api.files[url]
    if (body instanceof Error) throw body
    return body === undefined ? new Response("not found", { status: 404 }) : new Response(body)
  }
  const api: FakeApi = {
    calls,
    handlers,
    files: {},
    fileRequests: [],
    fetch,
    client: createClient({ url: "https://x.test", token: "xoxp-1", fetch }),
  }
  return api
}

export class FakeSocket extends EventTarget {
  static all: FakeSocket[] = []
  closed = false
  /** Frames the client sent, parsed. */
  sent: Record<string, unknown>[] = []
  constructor(readonly url: string) {
    super()
    FakeSocket.all.push(this)
  }
  send(data: string) {
    this.sent.push(JSON.parse(data) as Record<string, unknown>)
  }
  close() {
    if (this.closed) return
    this.closed = true
    this.dispatchEvent(new Event("close"))
  }
  receive(frame: unknown) {
    this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(frame) }))
  }
}

export const tick = () => new Promise((r) => setTimeout(r, 0))

/** Lets pending fetches and their follow-ups settle. */
export async function settle() {
  for (let i = 0; i < 10; i++) await tick()
}
