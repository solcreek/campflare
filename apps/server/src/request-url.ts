import { randomSecret } from "./api/ids"

// The Events API over HTTP: POSTs to an app's Request URL, signed with the
// app's signing secret as Slack signs them, so an app's existing verification
// (Bolt's receiver, or its own check) accepts them unchanged.

let requestUrlFetch: typeof fetch | undefined

/** For tests, which run in the Worker's isolate (the hub's too): answer Request URLs without the network. */
export function setRequestUrlFetch(fetcher: typeof fetch | undefined) {
  requestUrlFetch = fetcher
}

/** How long an app has to answer, as on Slack. */
export const REQUEST_TIMEOUT_MS = 3000

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"])

/** Why a Request URL can't be used, or undefined: https anywhere, or http on localhost (an app in development). */
export function requestUrlProblem(url: string): string | undefined {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return "request_url must be an absolute URL"
  }
  if (parsed.protocol === "https:" || (parsed.protocol === "http:" && LOOPBACK.has(parsed.hostname))) return undefined
  return "request_url must be https (or http on localhost)"
}

const utf8 = new TextEncoder()

/** `v0=` and the hex HMAC-SHA256 of `v0:<timestamp>:<body>` under the signing secret: Slack's X-Slack-Signature. */
export async function signature(secret: string, timestamp: number, body: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", utf8.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
  ])
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, utf8.encode(`v0:${timestamp}:${body}`)))
  return `v0=${[...mac].map((b) => b.toString(16).padStart(2, "0")).join("")}`
}

/** Slack's X-Slack-Retry-Reason values for the failures we can tell apart. */
export type FailureReason = "http_timeout" | "http_error" | "connection_failed"

export interface PostResult {
  ok: boolean
  /** 0 when there was no answer. */
  status: number
  reason?: FailureReason
  /** The app answered X-Slack-No-Retry: 1: don't send this one again. */
  noRetry: boolean
  body: string
}

/**
 * POSTs a body to a Request URL, signed, within the timeout: JSON for events,
 * a form (`payload=<json>`) for interactivity. A retry says which and why.
 */
export async function postSigned(
  url: string,
  secret: string,
  body: string,
  { retry, contentType = "application/json" }: { retry?: { num: number; reason: string }; contentType?: string } = {},
): Promise<PostResult> {
  // Each attempt is signed afresh: receivers reject a timestamp more than 5 minutes old.
  const timestamp = Math.floor(Date.now() / 1000)
  const headers: Record<string, string> = {
    "content-type": contentType,
    "user-agent": "Campflare-Events/1.0",
    "x-slack-request-timestamp": String(timestamp),
    "x-slack-signature": await signature(secret, timestamp, body),
  }
  if (retry) {
    headers["x-slack-retry-num"] = String(retry.num)
    headers["x-slack-retry-reason"] = retry.reason
  }
  try {
    const res = await (requestUrlFetch ?? fetch)(url, {
      method: "POST",
      headers,
      body,
      redirect: "manual",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
    const text = await res.text()
    const ok = res.status >= 200 && res.status < 300
    return {
      ok,
      status: res.status,
      ...(ok ? {} : { reason: "http_error" as const }),
      noRetry: res.headers.get("x-slack-no-retry") === "1",
      body: text,
    }
  } catch (error) {
    const timedOut = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")
    return { ok: false, status: 0, reason: timedOut ? "http_timeout" : "connection_failed", noRetry: false, body: "" }
  }
}

/**
 * Slack's url_verification: the app proves it answers at the URL by echoing
 * the challenge, as the plain body or as JSON `{"challenge": …}`.
 */
export async function verifyRequestUrl(url: string, secret: string): Promise<PostResult & { verified: boolean }> {
  const challenge = randomSecret(24)
  const res = await postSigned(url, secret, JSON.stringify({ token: "", challenge, type: "url_verification" }))
  let verified = false
  if (res.ok) {
    if (res.body.trim() === challenge) verified = true
    else {
      try {
        verified = (JSON.parse(res.body) as { challenge?: unknown }).challenge === challenge
      } catch {
        verified = false
      }
    }
  }
  return { ...res, verified }
}
