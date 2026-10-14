import type { Client } from "@campflare/client"
import { UsageError } from "./io"

// Names as people type them: "#general", "@bob", "@me", or an id.

export interface User {
  id: string
  name: string
  deleted?: boolean
  real_name?: string
  profile?: { display_name?: string; real_name?: string }
}

export interface Conversation {
  id: string
  name?: string
  is_im?: boolean
  is_mpim?: boolean
  is_private?: boolean
  user?: string
}

const ID = /^[CDGUW][A-Z0-9]{2,}$/

/** People matching a handle, display name or real name, exactly or by a unique word prefix. */
export function matchUsers(users: User[], query: string): User[] {
  const q = query.toLowerCase()
  const names = (u: User) =>
    [u.name, u.profile?.display_name, u.profile?.real_name, u.real_name]
      .filter((n): n is string => Boolean(n))
      .map((n) => n.toLowerCase())
  const live = users.filter((u) => !u.deleted)
  const exact = live.filter((u) => names(u).includes(q))
  if (exact.length > 0) return exact
  return live.filter((u) => names(u).some((n) => n.split(/\s+/).some((word) => word.startsWith(q))))
}

export async function resolveUser(client: Client, ref: string, self: () => Promise<string>): Promise<string> {
  const q = ref.replace(/^@/, "")
  if (q === "me") return self()
  if (ID.test(q) && q.startsWith("U")) return q
  const users = await client.paginate<User>("users.list", "members")
  const found = matchUsers(users, q)
  if (found.length === 1) return found[0]!.id
  if (found.length === 0) throw new UsageError(`no one matches @${q}`)
  const list = found.map((u) => `  @${u.name}  ${u.profile?.real_name ?? u.real_name ?? ""}`.trimEnd()).join("\n")
  throw new UsageError(`@${q} matches ${found.length} people:\n${list}`)
}

/** A conversation id for "#name", "@person" (their DM) or an id. */
export async function resolveConversation(client: Client, ref: string, self: () => Promise<string>): Promise<string> {
  if (ID.test(ref) && !ref.startsWith("U") && !ref.startsWith("W")) return ref
  if (ref.startsWith("@") || ID.test(ref)) {
    const user = await resolveUser(client, ref, self)
    const res = await client.call<{ ok: boolean; channel: { id: string } }>("conversations.open", { users: user })
    return res.channel.id
  }
  const name = ref.replace(/^#/, "").toLowerCase()
  const channels = await client.paginate<Conversation>("users.conversations", "channels", {
    types: "public_channel,private_channel",
    exclude_archived: true,
  })
  const found = channels.find((c) => c.name === name)
  if (found) return found.id
  // A bot posts to public channels without joining them.
  const isBot = await client.call<{ ok: boolean; bot_id?: string }>("auth.test").then((r) => Boolean(r.bot_id))
  if (isBot) {
    const all = await client.paginate<Conversation>("conversations.list", "channels", {
      types: "public_channel",
      exclude_archived: true,
    })
    const open = all.find((c) => c.name === name)
    if (open) return open.id
  }
  throw new UsageError(`you're not in #${name}`)
}
