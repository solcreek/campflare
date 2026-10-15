import { run, stmt } from "../db/query"
import type { AppRow, TeamRow, TokenRow, UserRow } from "../db/rows"
import type { Env } from "../env"
import { sha256Hex } from "./crypto"
import type { Auth } from "./context"
import { CampflareError } from "./errors"
import { expandScopes, FULL_USER_SCOPES } from "./scopes"

export { APP_SCOPES, DEFAULT_BOT_SCOPES, FULL_USER_SCOPES } from "./scopes"

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
  // Every request authenticates, so the token, its team, user and app come back in one round trip.
  const hash = await sha256Hex(token)
  const [tokens, teams, users, apps] = await env.DB.batch([
    stmt(env.DB, "SELECT * FROM tokens WHERE hash = ?", hash),
    stmt(env.DB, "SELECT * FROM teams WHERE id = (SELECT team_id FROM tokens WHERE hash = ?)", hash),
    stmt(env.DB, "SELECT * FROM users WHERE id = (SELECT user_id FROM tokens WHERE hash = ?)", hash),
    stmt(env.DB, "SELECT * FROM apps WHERE id = (SELECT app_id FROM tokens WHERE hash = ?)", hash),
  ])
  const row = tokens!.results[0] as TokenRow | undefined
  if (!row || row.revoked || row.kind !== kind)
    throw new CampflareError(row?.revoked ? "token_revoked" : "invalid_auth")
  if (row.expires !== null && row.expires <= Math.floor(Date.now() / 1000)) throw new CampflareError("token_expired")
  const team = teams!.results[0] as TeamRow | undefined
  if (!team) throw new CampflareError("invalid_auth")
  const user = users!.results[0] as UserRow | undefined
  if (row.user_id && (!user || user.deleted)) throw new CampflareError("account_inactive")
  const app = apps!.results[0] as AppRow | undefined
  return { kind, team, user, app, scopes: expandScopes(row.scopes) }
}

/** The identity of a Campflare user signed in some other way (an OAuth access token): as their user token would be. */
export async function actorFor(env: Env, userId: string, scopes = FULL_USER_SCOPES): Promise<Auth> {
  const [users, teams] = await env.DB.batch([
    stmt(env.DB, "SELECT * FROM users WHERE id = ?", userId),
    stmt(env.DB, "SELECT * FROM teams WHERE id = (SELECT team_id FROM users WHERE id = ?)", userId),
  ])
  const user = users!.results[0] as UserRow | undefined
  if (!user || user.deleted) throw new CampflareError("account_inactive")
  const team = teams!.results[0] as TeamRow | undefined
  if (!team) throw new CampflareError("invalid_auth")
  return { kind: user.is_bot ? "bot" : "user", team, user, scopes }
}

type TokenOptions = {
  teamId: string
  kind: Auth["kind"]
  userId?: string
  appId?: string
  /** Scopes and preset names (scopes.ts), stored as given. */
  scopes: string[]
  /** When it stops working, epoch seconds; never when absent. */
  expires?: number
  label?: string
  /** The OAuth client it is issued to (oauth.v2.access). */
  clientId?: string
}

/** A new token and the statement that stores its hash, for a caller that batches it with other writes. */
export async function prepareToken(
  env: Env,
  opts: TokenOptions,
): Promise<{ token: string; insert: D1PreparedStatement }> {
  const random = [...crypto.getRandomValues(new Uint8Array(24))].map((b) => b.toString(16).padStart(2, "0")).join("")
  const token = `${PREFIX[opts.kind]}${opts.teamId}-${random}`
  const insert = stmt(
    env.DB,
    "INSERT INTO tokens (hash, team_id, kind, user_id, app_id, scopes, label, client_id, created, expires) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    await sha256Hex(token),
    opts.teamId,
    opts.kind,
    opts.userId ?? null,
    opts.appId ?? null,
    opts.scopes.join(","),
    opts.label ?? "",
    opts.clientId ?? null,
    Math.floor(Date.now() / 1000),
    opts.expires ?? null,
  )
  return { token, insert }
}

/** Mints a token and stores its hash. The token is returned once. */
export async function issueToken(env: Env, opts: TokenOptions): Promise<string> {
  const { token, insert } = await prepareToken(env, opts)
  await insert.run()
  return token
}

/** Presence follows activity: a token used in the last 10 minutes reads "active". Written at most once a minute. */
export const ACTIVE_WINDOW = 10 * 60

export function touch(env: Env, user: UserRow): Promise<unknown> | undefined {
  const now = Math.floor(Date.now() / 1000)
  if (user.is_bot || now - user.last_activity < 60) return undefined
  return run(env.DB, "UPDATE users SET last_activity = ? WHERE id = ?", now, user.id)
}
