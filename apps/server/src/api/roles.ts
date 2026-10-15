import { first } from "../db/query"
import type { UserRow } from "../db/rows"
import type { Actor, Ctx } from "./context"
import { CampflareError } from "./errors"

// Roles (docs/scopes-and-roles.md): owner > admin > member. A token's scopes cap
// what it may do; the person's role, read with the token on every call, caps
// what they may do. Both must allow it.

/** A person's handle: what @mentions call them. */
export const HANDLE = /^[a-z0-9][a-z0-9._-]{0,79}$/

export function requireAdmin(ctx: Ctx<Actor>) {
  if (!ctx.auth.user.is_admin) throw new CampflareError("not_an_admin")
}

export function requireOwner(ctx: Ctx<Actor>) {
  if (!ctx.auth.user.is_owner) throw new CampflareError("not_an_owner")
}

export const rank = (u: Pick<UserRow, "is_admin" | "is_owner">) => (u.is_owner ? 2 : u.is_admin ? 1 : 0)

/** Acting for someone else (deactivating them, minting their token) takes a role above theirs. */
export function requireOutranks(ctx: Ctx<Actor>, target: UserRow) {
  requireAdmin(ctx)
  if (rank(ctx.auth.user) <= rank(target))
    throw new CampflareError(target.is_owner ? "cant_act_on_owner" : "not_an_owner")
}

/** A person of the caller's workspace, active; a bot user only with `bots`. */
export async function activePerson(ctx: Ctx<Actor>, id: string, { bots = false } = {}): Promise<UserRow> {
  const user = await first<UserRow>(
    ctx.env.DB,
    "SELECT * FROM users WHERE id = ? AND team_id = ? AND deleted = 0",
    id,
    ctx.auth.team.id,
  )
  if (!user) throw new CampflareError("user_not_found")
  if (user.is_bot && !bots) throw new CampflareError("user_is_bot")
  return user
}
