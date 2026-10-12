import { CampflareError } from "../api/errors"
import { nowSeconds } from "../api/ids"
import { all, run } from "../db/query"
import type { Env } from "../env"

// Passwords: PBKDF2-SHA256 through WebCrypto, which runs natively in Workers
// (a JavaScript scrypt would spend the request's CPU budget). 100,000
// iterations is the most Workers allow. Stored in our own `passwords` table,
// one row per Campflare user (migration 0007).

const ITERATIONS = 100_000
export const MIN_PASSWORD_LENGTH = 10
const MAX_PASSWORD_LENGTH = 1024
/** Wrong passwords in a row before the user is locked for LOCK_SECONDS. */
export const MAX_FAILURES = 5
export const LOCK_SECONDS = 60

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

/** Sets (or replaces) a user's password; it clears any lock from wrong guesses. */
export async function setPassword(env: Env, userId: string, password: string): Promise<void> {
  const hash = await hashPassword(checkPassword(password))
  await run(
    env.DB,
    `INSERT INTO passwords (user_id, hash, failures, locked_until, updated) VALUES (?, ?, 0, 0, ?)
     ON CONFLICT (user_id) DO UPDATE SET hash = excluded.hash, failures = 0, locked_until = 0, updated = excluded.updated`,
    userId,
    hash,
    nowSeconds(),
  )
}

interface Candidate {
  user_id: string
  hash: string
  locked_until: number
}

export type PasswordCheck =
  | { ok: true; userId: string }
  | { ok: false; error: "invalid_credentials" | "workspace_required" | "too_many_attempts" }

// Checked when no user has the email, so an unknown address takes as long as a wrong password.
let decoy: Promise<string> | undefined

/**
 * Finds the user an email and a password sign in. The same email may have a
 * password in several workspaces: each one's password is checked, and only
 * when it fits more than one is the workspace (its domain or name) needed.
 */
export async function checkCredentials(
  env: Env,
  email: string,
  password: string,
  workspace?: string,
): Promise<PasswordCheck> {
  const team = workspace?.trim().toLowerCase()
  const candidates = await all<Candidate>(
    env.DB,
    `SELECT p.user_id, p.hash, p.locked_until
     FROM users u JOIN passwords p ON p.user_id = u.id JOIN teams t ON t.id = u.team_id
     WHERE u.email = ? AND u.deleted = 0 AND u.is_bot = 0
       AND (? IS NULL OR lower(t.domain) = ? OR lower(t.name) = ?)
     LIMIT 20`,
    email.trim().toLowerCase(),
    team || null,
    team || null,
    team || null,
  )
  if (candidates.length === 0) {
    await verifyPassword(password, await (decoy ??= hashPassword("not anyone's password")))
    return { ok: false, error: "invalid_credentials" }
  }
  const now = nowSeconds()
  const open = candidates.filter((c) => c.locked_until <= now)
  const results = await Promise.all(open.map((c) => verifyPassword(password, c.hash)))
  const matches = open.filter((_, i) => results[i])
  if (matches.length === 1) {
    await run(env.DB, "UPDATE passwords SET failures = 0, locked_until = 0 WHERE user_id = ?", matches[0]!.user_id)
    return { ok: true, userId: matches[0]!.user_id }
  }
  if (matches.length > 1) return { ok: false, error: "workspace_required" }
  // A wrong password counts against every user it was tried on.
  if (open.length) {
    await run(
      env.DB,
      `UPDATE passwords SET failures = failures + 1,
         locked_until = CASE WHEN failures + 1 >= ? THEN ? ELSE locked_until END
       WHERE user_id IN (SELECT value FROM json_each(?))`,
      MAX_FAILURES,
      now + LOCK_SECONDS,
      JSON.stringify(open.map((c) => c.user_id)),
    )
  }
  return { ok: false, error: open.length < candidates.length ? "too_many_attempts" : "invalid_credentials" }
}
