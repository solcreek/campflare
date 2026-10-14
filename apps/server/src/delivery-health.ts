import type { PostResult } from "./request-url"

// How an app's Request URL is doing, kept in the team hub's SQLite: every
// Events API POST (first attempts and retries alike) is counted in one-minute
// buckets over a rolling hour, and the last attempt is remembered. An app
// whose URL fails nearly everything is switched off, as Slack does.
// Interactivity POSTs don't go through the hub and don't count.

/** The rolling window failures are counted over. */
export const HEALTH_WINDOW_MINUTES = 60
/** More than this share of attempts failing in the window turns delivery off… */
export const DISABLE_FAILURE_RATE = 0.95
/**
 * …once the window holds at least this many attempts, so a quiet app isn't
 * turned off by a blip: with 3 retries per event, 20 attempts is at least
 * five events that all failed.
 */
export const DISABLE_MIN_ATTEMPTS = 20

/** An app's delivery health, as campflare.apps.info shows it. */
export interface DeliveryHealth {
  last_attempt: { at: number; ok: boolean; status: number; reason: string | null } | null
  window_minutes: number
  attempts: number
  failures: number
  /** Events waiting for a retry. */
  pending: number
}

export function createHealthTables(sql: SqlStorage) {
  sql.exec(`CREATE TABLE IF NOT EXISTS delivery_minutes (
    app_id TEXT NOT NULL,
    minute INTEGER NOT NULL,
    attempts INTEGER NOT NULL,
    failures INTEGER NOT NULL,
    PRIMARY KEY (app_id, minute)
  )`)
  sql.exec(`CREATE TABLE IF NOT EXISTS delivery_last (
    app_id TEXT PRIMARY KEY,
    at INTEGER NOT NULL,
    ok INTEGER NOT NULL,
    status INTEGER NOT NULL,
    reason TEXT
  )`)
}

const minuteOf = (ms: number) => Math.floor(ms / 60_000)

/**
 * Counts one attempt. Returns the window's totals when they cross the line
 * (more than 95% failed, at least DISABLE_MIN_ATTEMPTS), else undefined.
 */
export function recordAttempt(
  sql: SqlStorage,
  appId: string,
  res: Pick<PostResult, "ok" | "status" | "reason">,
  now = Date.now(),
): { attempts: number; failures: number } | undefined {
  const minute = minuteOf(now)
  const failed = res.ok ? 0 : 1
  sql.exec("DELETE FROM delivery_minutes WHERE app_id = ? AND minute <= ?", appId, minute - HEALTH_WINDOW_MINUTES)
  sql.exec(
    `INSERT INTO delivery_minutes (app_id, minute, attempts, failures) VALUES (?, ?, 1, ?)
     ON CONFLICT (app_id, minute) DO UPDATE SET attempts = attempts + 1, failures = failures + excluded.failures`,
    appId,
    minute,
    failed,
  )
  sql.exec(
    "INSERT OR REPLACE INTO delivery_last (app_id, at, ok, status, reason) VALUES (?, ?, ?, ?, ?)",
    appId,
    now,
    res.ok ? 1 : 0,
    res.status,
    res.reason ?? null,
  )
  if (res.ok) return undefined
  const totals = windowTotals(sql, appId, now)
  return totals.attempts >= DISABLE_MIN_ATTEMPTS && totals.failures > totals.attempts * DISABLE_FAILURE_RATE
    ? totals
    : undefined
}

function windowTotals(sql: SqlStorage, appId: string, now: number) {
  const row = sql
    .exec<{ attempts: number | null; failures: number | null }>(
      "SELECT SUM(attempts) AS attempts, SUM(failures) AS failures FROM delivery_minutes WHERE app_id = ? AND minute > ?",
      appId,
      minuteOf(now) - HEALTH_WINDOW_MINUTES,
    )
    .toArray()[0]
  return { attempts: row?.attempts ?? 0, failures: row?.failures ?? 0 }
}

/** Starts the window afresh (a new Request URL); the last attempt is kept. */
export function resetWindow(sql: SqlStorage, appId: string) {
  sql.exec("DELETE FROM delivery_minutes WHERE app_id = ?", appId)
}

export function healthOf(sql: SqlStorage, appId: string, now = Date.now()): DeliveryHealth {
  const last = sql
    .exec<{ at: number; ok: number; status: number; reason: string | null }>(
      "SELECT at, ok, status, reason FROM delivery_last WHERE app_id = ?",
      appId,
    )
    .toArray()[0]
  const pending = sql
    .exec<{ n: number }>("SELECT COUNT(*) AS n FROM unacked WHERE app_id = ? AND transport = 'http'", appId)
    .toArray()[0]!.n
  return {
    last_attempt: last
      ? { at: Math.floor(last.at / 1000), ok: last.ok === 1, status: last.status, reason: last.reason }
      : null,
    window_minutes: HEALTH_WINDOW_MINUTES,
    ...windowTotals(sql, appId, now),
    pending,
  }
}
