import type { Env } from "../env"
import { all } from "./query"
import type { UsergroupRow } from "./rows"

// User groups (usergroups.*): reads shared by the methods and, later, by
// whatever notifies people of a group mention.

/** A group with its active members, as one query reads it. */
export interface UsergroupWithMembers extends UsergroupRow {
  /** JSON array of the active members' ids. */
  members: string
}

/** Selects groups with their members (active people only); add the WHERE. */
export const GROUPS_WITH_MEMBERS = `SELECT g.*,
  (SELECT json_group_array(m.user_id) FROM usergroup_members m JOIN users u ON u.id = m.user_id AND u.deleted = 0
   WHERE m.usergroup_id = g.id) AS members
  FROM usergroups g`

/** The ids a group mention names in message text: <!subteam^S123> and <!subteam^S123|@handle>. */
export function subteamMentions(text: string): string[] {
  return [...new Set([...text.matchAll(/<!subteam\^(S[A-Z0-9]+)(?:\|[^>]*)?>/g)].map((m) => m[1]!))]
}

/**
 * Everyone a mention of these groups reaches: the active members of those that
 * are enabled and in this workspace, each once. One query, whatever the count.
 */
export async function groupMembers(env: Pick<Env, "DB">, teamId: string, groupIds: string[]): Promise<string[]> {
  if (groupIds.length === 0) return []
  const rows = await all<{ user_id: string }>(
    env.DB,
    `SELECT DISTINCT m.user_id FROM usergroup_members m
     JOIN usergroups g ON g.id = m.usergroup_id
     JOIN users u ON u.id = m.user_id AND u.deleted = 0
     WHERE g.team_id = ? AND g.date_delete = 0 AND g.id IN (SELECT value FROM json_each(?))`,
    teamId,
    JSON.stringify(groupIds),
  )
  return rows.map((r) => r.user_id)
}
