import { normalizeEmail } from "../api/email-address"
import { CampflareError } from "../api/errors"
import { nowSeconds } from "../api/ids"
import { run, stmt } from "../db/query"
import type { Env } from "../env"
import { CAMPFLARE_PROVIDER } from "./sign-in"
import {
  addressChecks,
  counter,
  countFailure,
  EMAIL_CEILING,
  forgetEmail,
  IP_FREE_FAILURES,
  keys,
  PAIR_FREE_FAILURES,
  readCounter,
  waitFor,
} from "./throttle"

// Passwords: PBKDF2-SHA256 through WebCrypto, which runs natively in Workers
// (a JavaScript scrypt would spend the request's CPU budget). 100,000
// iterations is the most Workers allow. Stored in our own `passwords` table,
// one row per Campflare user (migration 0007).

const ITERATIONS = 100_000
export const MIN_PASSWORD_LENGTH = 10
const MAX_PASSWORD_LENGTH = 1024

const encoder = new TextEncoder()
const toBase64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes))
const fromBase64 = (text: string) => Uint8Array.from(atob(text), (c) => c.charCodeAt(0))

// The same text typed on different keyboards (precomposed é, or e and a combining accent) is the same password.
const normalize = (password: string) => password.normalize("NFC")

async function derive(password: string, salt: Uint8Array<ArrayBuffer>, iterations: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", encoder.encode(normalize(password)), "PBKDF2", false, ["deriveBits"])
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations }, key, 256))
}

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16))
  return `pbkdf2-sha256$${ITERATIONS}$${toBase64(salt)}$${toBase64(await derive(password, salt, ITERATIONS))}`
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, iterations, salt, key] = stored.split("$")
  if (scheme !== "pbkdf2-sha256" || !iterations || !salt || !key) return false
  const expected = fromBase64(key)
  const actual = await derive(password, fromBase64(salt), Number(iterations))
  // Constant time: compare every byte whatever the first difference.
  let diff = expected.length ^ actual.length
  for (let i = 0; i < expected.length; i++) diff |= expected[i]! ^ (actual[i] ?? 0)
  return diff === 0
}

/** A password Campflare accepts, or invalid_password with the reason in response_metadata. */
export function checkPassword(password: string): string {
  const length = [...normalize(password)].length
  const problem =
    length < MIN_PASSWORD_LENGTH
      ? `a password needs at least ${MIN_PASSWORD_LENGTH} characters`
      : length > MAX_PASSWORD_LENGTH
        ? `a password has at most ${MAX_PASSWORD_LENGTH} characters`
        : password.trim() === ""
          ? "a password can't be only spaces"
          : undefined
  if (problem) {
    throw new CampflareError("invalid_password", { response_metadata: { messages: [`[ERROR] ${problem}`] } })
  }
  return password
}

/**
 * Sets (or replaces) a user's password. It ends the person's sign-ins in the
 * browser (their Better Auth sessions), revokes what MCP clients were granted
 * through them (Better Auth's access and refresh tokens; consent stays, so a
 * client the person trusts signs in again without being asked), and forgets
 * wrong guesses at their email. JWT access tokens are not stored anywhere:
 * /mcp refuses those issued before `passwords.updated` (src/mcp/index.ts).
 * Their xoxp tokens stay: those are apps they installed, revoked one by one.
 */
export async function setPassword(
  env: Env,
  user: { id: string; email?: string | null },
  password: string,
): Promise<void> {
  await env.DB.batch(passwordStatements(env, user, await hashPassword(checkPassword(password))))
}

/** A SQL condition with its parameters: setPassword's writes happen only where it holds. */
export interface Guard {
  sql: string
  params: unknown[]
}

/**
 * setPassword's writes, for a caller that batches them with its own (a reset
 * link's claim). With `when`, each write happens only where that condition
 * holds, evaluated as the batch runs.
 */
export function passwordStatements(
  env: Env,
  user: { id: string; email?: string | null },
  hash: string,
  when: Guard = { sql: "1", params: [] },
): D1PreparedStatement[] {
  // The Better Auth user linked to this Campflare user (one per person, src/auth/sign-in.ts).
  const linked = `SELECT "userId" FROM "account" WHERE "providerId" = ? AND "accountId" = ?`
  const drop = (table: string) =>
    stmt(
      env.DB,
      `DELETE FROM "${table}" WHERE "userId" IN (${linked}) AND (${when.sql})`,
      CAMPFLARE_PROVIDER,
      user.id,
      ...when.params,
    )
  return [
    stmt(
      env.DB,
      // WHERE before ON CONFLICT: SQLite's upsert from a SELECT needs it to parse.
      `INSERT INTO passwords (user_id, hash, updated) SELECT ?, ?, ? WHERE (${when.sql})
       ON CONFLICT (user_id) DO UPDATE SET hash = excluded.hash, updated = excluded.updated`,
      user.id,
      hash,
      nowSeconds(),
      ...when.params,
    ),
    drop("oauthAccessToken"),
    drop("oauthRefreshToken"),
    drop("session"),
    ...(user.email ? [forgetEmail(env.DB, normalizeEmail(user.email))] : []),
  ]
}

interface Candidate {
  user_id: string
  hash: string
}

export type PasswordCheck =
  | { ok: true; userId: string }
  | { ok: false; error: "invalid_credentials" | "workspace_required" }
  | { ok: false; error: "too_many_attempts"; retryAfter: number }

// Checked when no user has the email, so an unknown address takes as long as a wrong password.
let decoy: Promise<string> | undefined

/** Free failures past which each one makes the next attempt wait; the email counter never blocks. */
const NEVER = 2 ** 31

/**
 * Finds the user an email and a password sign in. The same email may have a
 * password in several workspaces: each one's password is checked, and only
 * when it fits more than one is the workspace (its domain or name) needed.
 * `ip` is the client's address: guessing is throttled per address and per
 * email and address (src/auth/throttle.ts), never for the email alone.
 */
export async function checkCredentials(
  env: Env,
  email: string,
  password: string,
  ip: string,
  workspace?: string,
): Promise<PasswordCheck> {
  const team = workspace?.trim().toLowerCase()
  const address = normalizeEmail(email)
  const now = nowSeconds()
  const results = await env.DB.batch([
    ...addressChecks(env.DB, ip, now),
    readCounter(env.DB, keys.pair(address, ip), now),
    readCounter(env.DB, keys.email(address), now),
    stmt(
      env.DB,
      `SELECT p.user_id, p.hash
       FROM users u JOIN passwords p ON p.user_id = u.id JOIN teams t ON t.id = u.team_id
       WHERE u.email = ? AND u.deleted = 0 AND u.is_bot = 0
         AND (? IS NULL OR lower(t.domain) = ? OR lower(t.name) = ?)
       LIMIT 20`,
      address,
      team || null,
      team || null,
      team || null,
    ),
  ])
  const pair = counter(results[3])
  const wait = waitFor(results, now, pair)
  if (wait !== undefined) return { ok: false, error: "too_many_attempts", retryAfter: wait }

  const candidates = results[5]!.results as unknown as Candidate[]
  if (!candidates.length) await verifyPassword(password, await (decoy ??= hashPassword("not anyone's password")))
  const verified = await Promise.all(candidates.map((c) => verifyPassword(password, c.hash)))
  const matches = candidates.filter((_, i) => verified[i])
  if (matches.length === 1) {
    // The right password from this address: its wrong ones before don't count any more.
    if (pair.count) await run(env.DB, "DELETE FROM sign_in_throttle WHERE key = ?", keys.pair(address, ip))
    return { ok: true, userId: matches[0]!.user_id }
  }
  if (matches.length > 1) return { ok: false, error: "workspace_required" }
  const crowded = counter(results[4]).count >= EMAIL_CEILING
  await env.DB.batch([
    countFailure(env.DB, keys.ip(ip), now, IP_FREE_FAILURES),
    countFailure(env.DB, keys.pair(address, ip), now, crowded ? 1 : PAIR_FREE_FAILURES),
    countFailure(env.DB, keys.email(address), now, NEVER),
  ])
  return { ok: false, error: "invalid_credentials" }
}
