import { sign, verify } from "../api/crypto"

// Tickets for the SFU's WebSocket adapter endpoint (/huddle/scribe/<ticket>):
// the adapter can't send headers, so the URL carries which call and speaker a
// connection is. Reusable until it expires: the SFU reconnects with the same
// URL. Pure, so Node tooling (live tests) can make them too.

/** The adapter endpoint's ticket: which call and speaker a connection carries. Reusable until it expires (the SFU reconnects with it). */
export interface ScribeTicket {
  teamId: string
  channelId: string
  user: string
  expires: number
}

const TICKET_TTL_MS = 6 * 60 * 60 * 1000
const b64url = (s: string) => btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")

export async function scribeTicket(key: string, t: Omit<ScribeTicket, "expires">): Promise<string> {
  return sign(key, b64url(JSON.stringify({ ...t, expires: Date.now() + TICKET_TTL_MS })))
}

export async function readScribeTicket(key: string, signed: string): Promise<ScribeTicket | undefined> {
  const payload = await verify(key, signed)
  if (!payload) return undefined
  try {
    const t = JSON.parse(atob(payload.replace(/-/g, "+").replace(/_/g, "/"))) as ScribeTicket
    return t.expires > Date.now() ? t : undefined
  } catch {
    return undefined
  }
}
