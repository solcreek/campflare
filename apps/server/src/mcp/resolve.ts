import { first } from "../db/query"
import type { ConversationRow, UserRow } from "../db/rows"
import { CampflareError } from "../api/errors"
import type { Caller } from "./invoke"
import { invoke } from "./invoke"

/** A conversation as people name it: "#channel", "@handle" (your DM with them), or an id. */
export async function conversationId(caller: Caller, ref: string): Promise<string> {
  if (ref.startsWith("@")) return (await dmWith(caller, ref)).id
  if (!ref.startsWith("#")) return ref
  const row = await first<Pick<ConversationRow, "id">>(
    caller.env.DB,
    "SELECT id FROM conversations WHERE team_id = ? AND kind = 'channel' AND name = ?",
    caller.auth.team.id,
    ref.slice(1).toLowerCase(),
  )
  if (!row) throw new CampflareError("channel_not_found")
  return row.id
}

async function dmWith(caller: Caller, ref: string): Promise<{ id: string }> {
  const userId = await userIdOf(caller, ref)
  const res = await invoke<{ channel: { id: string } }>(caller, "conversations.open", { users: userId })
  return res.channel
}

/** A user id for "@handle", "@me", a display name, or an id. */
export async function userIdOf(caller: Caller, ref: string): Promise<string> {
  const q = ref.replace(/^@/, "")
  if (q === "me") return caller.auth.user.id
  const user = await first<Pick<UserRow, "id">>(
    caller.env.DB,
    `SELECT id FROM users WHERE team_id = ? AND deleted = 0
       AND (id = ? OR lower(name) = lower(?) OR lower(display_name) = lower(?))`,
    caller.auth.team.id,
    q,
    q,
    q,
  )
  if (!user) throw new CampflareError("user_not_found")
  return user.id
}
