import { first, run } from "../db/query"
import type { AppRow, TeamRow, TokenRow, UserRow } from "../db/rows"
import type { Env } from "../env"
import { sha256Hex } from "./crypto"
import type { Auth } from "./context"
import { CampflareError } from "./errors"

export const DEFAULT_USER_SCOPES = [
  "channels:history",
  "channels:read",
  "channels:write",
  "chat:write",
  "dnd:read",
  "dnd:write",
  "emoji:read",
  "files:read",
  "files:write",
  "groups:history",
  "groups:read",
  "groups:write",
  "im:history",
  "im:read",
  "im:write",
  "mpim:history",
  "mpim:read",
  "mpim:write",
  "reactions:read",
  "reactions:write",
  "search:read",
  "team:read",
  "users:read",
  "users:read.email",
  "users:write",
  "users.profile:read",
  "users.profile:write",
]

export const DEFAULT_BOT_SCOPES = [
  "channels:history",
  "channels:join",
  "channels:read",
  "chat:write",
  "chat:write.public",
  "files:read",
  "files:write",
  "groups:history",
  "groups:read",
  "im:history",
  "im:read",
  "im:write",
  "mpim:history",
  "mpim:read",
  "reactions:read",
  "reactions:write",
  "team:read",
  "users:read",
]

export const APP_SCOPES = ["connections:write"]

const PREFIX = { user: "xoxp-", bot: "xoxb-", app: "xapp-" } as const

/** The token a request carries: `Authorization: Bearer …`, or a `token` argument. */
export function tokenOf(request: Request, argToken: string | undefined): string | undefined {
  const header = request.headers.get("authorization")
  const match = header?.match(/^Bearer\s+(\S+)$/i)
  return match?.[1] ?? argToken
}

export async function authenticate(env: Env, token: string): Promise<Auth> {
  const kind = (Object.keys(PREFIX) as (keyof typeof PREFIX)[]).find((k) => token.startsWith(PREFIX[k]))
  if (!kind) throw new CampflareError("invalid_auth")
  const row = await first<TokenRow>(env.DB, "SELECT * FROM tokens WHERE hash = ?", await sha256Hex(token))
  if (!row || row.revoked || row.kind !== kind)
    throw new CampflareError(row?.revoked ? "token_revoked" : "invalid_auth")
  const team = await first<TeamRow>(env.DB, "SELECT * FROM teams WHERE id = ?", row.team_id)
  if (!team) throw new CampflareError("invalid_auth")
  const user = row.user_id ? await first<UserRow>(env.DB, "SELECT * FROM users WHERE id = ?", row.user_id) : undefined
  if (row.user_id && (!user || user.deleted)) throw new CampflareError("account_inactive")
  const app = row.app_id ? await first<AppRow>(env.DB, "SELECT * FROM apps WHERE id = ?", row.app_id) : undefined
  return { kind, team, user, app, scopes: row.scopes ? row.scopes.split(",") : [] }
}

/** Mints a token and stores its hash. The token is returned once. */
export async function issueToken(
  env: Env,
  opts: { teamId: string; kind: Auth["kind"]; userId?: string; appId?: string; scopes: string[]; label?: string },
): Promise<string> {
  const random = [...crypto.getRandomValues(new Uint8Array(24))].map((b) => b.toString(16).padStart(2, "0")).join("")
  const token = `${PREFIX[opts.kind]}${opts.teamId}-${random}`
  await run(
    env.DB,
    "INSERT INTO tokens (hash, team_id, kind, user_id, app_id, scopes, label, created) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    await sha256Hex(token),
    opts.teamId,
    opts.kind,
    opts.userId ?? null,
    opts.appId ?? null,
    opts.scopes.join(","),
    opts.label ?? "",
    Math.floor(Date.now() / 1000),
  )
  return token
}

/** Presence follows activity: a token used in the last 10 minutes reads "active". Written at most once a minute. */
export const ACTIVE_WINDOW = 10 * 60

export function touch(env: Env, user: UserRow): Promise<unknown> | undefined {
  const now = Math.floor(Date.now() / 1000)
  if (user.is_bot || now - user.last_activity < 60) return undefined
  return run(env.DB, "UPDATE users SET last_activity = ? WHERE id = ?", now, user.id)
}
