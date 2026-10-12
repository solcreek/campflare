import type { RealtimeEvent } from "./realtime"
import { ApiError, type ApiResult, type Client } from "./web"

// Campflare's event log (campflare.events.poll), followed by long-polling:
// live events for clients that can't hold a WebSocket open, resumable from a
// cursor. Campflare only; Slack has no such method.

export interface FollowOptions {
  client: Client
  /** Resume after this cursor; omitted, start from now. */
  cursor?: string
  onEvent: (event: RealtimeEvent, cursor: string) => void
  /** The cursor after each page, to save for resuming. */
  onCursor?: (cursor: string) => void
  /** The cursor was too old: events were missed, and following restarts from now. */
  onGap?: () => void
  onError?: (error: unknown) => void
  /** Seconds each poll waits for news (the server allows up to 30). */
  waitSeconds?: number
  minDelayMs?: number
  maxDelayMs?: number
  sleep?: (ms: number) => Promise<void>
}

export interface Follower {
  close(): void
  /** Settles once closed. */
  done: Promise<void>
}

interface PollPage extends ApiResult {
  events: { cursor: string; event: RealtimeEvent }[]
  cursor: string
  has_more: boolean
}

export function follow(options: FollowOptions): Follower {
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  const wait = options.waitSeconds ?? 30
  const minDelay = options.minDelayMs ?? 1000
  const maxDelay = options.maxDelayMs ?? 30_000
  // An object, not a flag: close() flips it from outside the loop that reads it.
  const state = { closed: false }

  async function run() {
    let cursor = options.cursor
    let delay = minDelay
    while (!state.closed) {
      try {
        if (cursor === undefined) {
          cursor = (await options.client.call<PollPage>("campflare.events.poll")).cursor
          options.onCursor?.(cursor)
          continue
        }
        const page = await options.client.call<PollPage>("campflare.events.poll", { cursor, wait })
        delay = minDelay
        if (state.closed) return
        for (const { event, cursor: at } of page.events) options.onEvent(event, at)
        cursor = page.cursor
        options.onCursor?.(cursor)
      } catch (error) {
        if (state.closed) return
        if (error instanceof ApiError && error.code === "cursor_expired") {
          options.onGap?.()
          cursor = undefined
          continue
        }
        options.onError?.(error)
        await sleep(delay)
        delay = Math.min(delay * 2, maxDelay)
      }
    }
  }

  const done = run()
  return {
    close() {
      state.closed = true
    },
    done,
  }
}
