import type { Connection } from "../hub"
import { sign, verify } from "./crypto"
import { randomSecret } from "./ids"

// WebSocket URLs carry a signed, short-lived, single-use ticket holding the
// connection it opens, so the upgrade needs no database read.

const TTL_MS = 60_000

export type Ticket = Omit<Connection, "connectedAt"> & { nonce: string; expires: number }

const b64url = (s: string) => btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
const unb64url = (s: string) => atob(s.replace(/-/g, "+").replace(/_/g, "/"))

export async function issueTicket(key: string, conn: Omit<Connection, "connectedAt">): Promise<string> {
  const ticket: Ticket = { ...conn, nonce: randomSecret(12), expires: Date.now() + TTL_MS }
  return sign(key, b64url(JSON.stringify(ticket)))
}

export async function readTicket(key: string, signed: string): Promise<Ticket | undefined> {
  const payload = await verify(key, signed)
  if (!payload) return undefined
  try {
    const ticket = JSON.parse(unb64url(payload)) as Ticket
    return ticket.expires > Date.now() ? ticket : undefined
  } catch {
    return undefined
  }
}

export function wsOrigin(origin: string) {
  return origin.replace(/^http/, "ws")
}
