import { stmt } from "../db/query"

// Slowing down guessing at sign-in without letting anyone lock a person out.
// Counters live in D1 (sign_in_throttle, migration 0008), read in the same
// batch as the sign-in's own query and written in one batch after it:
//
// - rate:<ip>, every attempt from an address: at most RATE_LIMIT a minute.
// - ip:<ip>, failures from an address (any email, or a token): IP_FREE_FAILURES
//   free, then exponential backoff. Bounds one address spraying many emails.
// - pair:<email>:<ip>, wrong passwords for an email from one address:
//   PAIR_FREE_FAILURES free, then exponential backoff. Bounds targeted
//   guessing, and blocks only the address that guessed, never the person
//   signing in from elsewhere. Unknown emails count the same way, so a
//   throttled answer says nothing about whether the email has a password.
// - email:<email>, wrong passwords from every address: never blocks, but past
//   EMAIL_CEILING each address gets one free try instead of five, which slows
//   a guesser spread over many addresses while the person, from an address
//   that hasn't guessed, still signs in at the first right try.
//
// The client address is CF-Connecting-IP, which Cloudflare sets on every
// request; in tests and local dev it is missing and every attempt shares one.

export const RATE_LIMIT = 30
export const RATE_WINDOW = 60
export const IP_FREE_FAILURES = 20
export const PAIR_FREE_FAILURES = 5
export const EMAIL_CEILING = 50
/** The first wait after the free tries; each further failure doubles it, up to BACKOFF_MAX. */
export const BACKOFF_BASE = 15
export const BACKOFF_MAX = 3600
/** A failure is forgotten this long after its wait ends. */
export const FAILURE_WINDOW = 86_400
const PRUNE_BATCH = 50

const LOCAL_ADDRESS = "local"

export const clientAddress = (headers: Headers | undefined) => headers?.get("cf-connecting-ip")?.trim() || LOCAL_ADDRESS

export const keys = {
  rate: (ip: string) => `rate:${ip}`,
  ip: (ip: string) => `ip:${ip}`,
  pair: (email: string, ip: string) => `pair:${email}:${ip}`,
  email: (email: string) => `email:${email}`,
}

/** Drops a few expired counters, so the table holds only live ones. */
export const prune = (db: D1Database, now: number) =>
  stmt(
    db,
    "DELETE FROM sign_in_throttle WHERE key IN (SELECT key FROM sign_in_throttle WHERE expires <= ? LIMIT ?)",
    now,
    PRUNE_BATCH,
  )

/** Counts an attempt from the address; answers this minute's count and when the minute ends. */
export const countAttempt = (db: D1Database, ip: string, now: number) =>
  stmt(
    db,
    `INSERT INTO sign_in_throttle (key, count, expires) VALUES (?1, 1, ?2 + ?3)
     ON CONFLICT (key) DO UPDATE SET
       count = CASE WHEN expires <= ?2 THEN 1 ELSE count + 1 END,
       expires = CASE WHEN expires <= ?2 THEN ?2 + ?3 ELSE expires END
     RETURNING count, expires`,
    keys.rate(ip),
    now,
    RATE_WINDOW,
  )

/** A counter's live state: blocked_until and count, zero once it has expired. */
export const readCounter = (db: D1Database, key: string, now: number) =>
  stmt(
    db,
    `SELECT coalesce(max(blocked_until), 0) AS blocked_until, coalesce(max(count), 0) AS count
     FROM sign_in_throttle WHERE key = ? AND expires > ?`,
    key,
    now,
  )

export interface Counter {
  blocked_until: number
  count: number
}

// The wait after `count` failures, `free` of them allowed without one: none
// before the free ones are used, then BACKOFF_BASE, doubling with each further
// failure up to BACKOFF_MAX.
const wait = (count: string) =>
  `CASE WHEN ${count} >= ?3 THEN min(${BACKOFF_BASE} << min(${count} - ?3, 20), ${BACKOFF_MAX}) ELSE 0 END`

/** Counts a failure against a key; once `free` of them are counted, each makes the next attempt wait. */
export function countFailure(db: D1Database, key: string, now: number, free: number) {
  const count = "(CASE WHEN expires <= ?2 THEN 1 ELSE count + 1 END)"
  return stmt(
    db,
    `INSERT INTO sign_in_throttle (key, count, blocked_until, expires)
     VALUES (?1, 1, ?2 + ${wait("1")}, ?2 + ${wait("1")} + ?4)
     ON CONFLICT (key) DO UPDATE SET
       count = ${count},
       blocked_until = ?2 + ${wait(count)},
       expires = ?2 + ${wait(count)} + ?4`,
    key,
    now,
    free,
    FAILURE_WINDOW,
  )
}

/** Forgets the failures of an email, from every address. */
export const forgetEmail = (db: D1Database, email: string) =>
  stmt(
    db,
    // Keys "pair:<email>:" to "pair:<email>;" are this email's pairs (";" sorts right after ":").
    "DELETE FROM sign_in_throttle WHERE key = ?1 OR (key > ?2 || ':' AND key < ?2 || ';')",
    keys.email(email),
    `pair:${email}`,
  )

/** How long until a blocked_until (unix seconds), at least a second, for Retry-After. */
export const secondsUntil = (until: number, now: number) => Math.max(1, until - now)

/** The statements every sign-in attempt starts its batch with: prune, count it, read the address's failures. */
export const addressChecks = (db: D1Database, ip: string, now: number) => [
  prune(db, now),
  countAttempt(db, ip, now),
  readCounter(db, keys.ip(ip), now),
]

const row = <T>(result: D1Result | undefined) => result!.results[0] as T

/**
 * Seconds to wait before the address may try again, from the results of
 * addressChecks and any further counters read with readCounter; undefined
 * when it may try now.
 */
export function waitFor(results: D1Result[], now: number, ...counters: Counter[]): number | undefined {
  const rate = row<{ count: number; expires: number }>(results[1])
  const waits = [
    rate.count > RATE_LIMIT ? rate.expires : 0,
    row<Counter>(results[2]).blocked_until,
    ...counters.map((c) => c.blocked_until),
  ].filter((until) => until > now)
  return waits.length ? secondsUntil(Math.max(...waits), now) : undefined
}

export const counter = (result: D1Result | undefined) => row<Counter>(result)
