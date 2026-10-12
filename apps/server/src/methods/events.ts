import { method } from "../api/context"
import { CampflareError } from "../api/errors"

/**
 * The events the token's user can see, in order, from a cursor: what an RTM
 * link would have delivered, for clients that can't hold one open (agents,
 * scripts, serverless jobs). Without a cursor it answers the current one, to
 * start from. `wait` (seconds, up to 30) long-polls when nothing is new yet.
 */
method("campflare.events.poll", "actor", async (ctx) => {
  const raw = ctx.args.str("cursor")
  if (raw !== undefined && !/^\d+$/.test(raw)) throw new CampflareError("invalid_cursor")
  const wait = ctx.args.int("wait", 0, { min: 0, max: 30 })
  const limit = ctx.args.int("limit", 100, { min: 1, max: 200 })
  const hub = ctx.env.HUB.get(ctx.env.HUB.idFromName(ctx.auth.team.id))
  const result = await hub.poll({
    user: ctx.auth.user.id,
    cursor: raw === undefined ? undefined : Number(raw),
    limit,
    waitMs: wait * 1000,
  })
  if (result.error) {
    if (result.error === "cursor_expired") {
      throw new CampflareError("cursor_expired", {
        response_metadata: { messages: ["[ERROR] events before this cursor were dropped: start again without one"] },
      })
    }
    throw new CampflareError(result.error)
  }
  return {
    events: result.events.map((e) => ({ cursor: e.cursor, event: JSON.parse(e.event) as unknown })),
    cursor: result.cursor,
    has_more: result.hasMore,
  }
})
