import { createClient, type Client } from "@campflare/client"

// Test doubles for apps built on @campflare/core (import "@campflare/core/testing"):
// a scripted Web API and a WebSocket the test drives by hand.

export type Handler = (args: Record<string, string>) => Record<string, unknown> | Error

export interface FakeApi {
  client: Client
  calls: { method: string; args: Record<string, string> }[]
  handlers: Record<string, Handler>
}

export function fakeApi(handlers: Record<string, Handler>): FakeApi {
  const calls: FakeApi["calls"] = []
  const api: FakeApi = {
    calls,
    handlers,
    client: createClient({
      url: "https://x.test",
      token: "xoxp-1",
      fetch: async (input, init) => {
        const method = String(input).split("/api/")[1]!
        const args = Object.fromEntries(new URLSearchParams(String(init?.body ?? "")))
        calls.push({ method, args })
        const handler = api.handlers[method]
        if (!handler) return Response.json({ ok: false, error: "unknown_method" })
        const result = handler(args)
        if (result instanceof Error) return Response.json({ ok: false, error: result.message })
        return Response.json({ ok: true, ...result })
      },
    }),
  }
  return api
}

export class FakeSocket extends EventTarget {
  static all: FakeSocket[] = []
  closed = false
  constructor(readonly url: string) {
    super()
    FakeSocket.all.push(this)
  }
  send(_data: string) {}
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
