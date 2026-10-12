import { requireReadable, resolveConversation } from "../db/conversations"
import { messageOut, requireMessage } from "../db/messages"
import { isUniqueViolation, stmt } from "../db/query"
import { audienceFrom, audienceStatement, publish } from "../events"
import { method, type Actor, type Ctx } from "../api/context"
import { CampflareError } from "../api/errors"
import { permalink } from "../api/shapes"

const MAX_DISTINCT = 50

async function target(ctx: Ctx<Actor>) {
  const c = await resolveConversation(ctx, ctx.args.req("channel", "channel_not_found"))
  await requireReadable(ctx, c)
  const ts = ctx.args.ts("timestamp")
  if (!ts) throw new CampflareError("no_item_specified")
  const message = await requireMessage(ctx, c.id, ts)
  return { c, message }
}

/** "thumbsup", ":thumbsup:", "+1::skin-tone-2" → the stored name. */
function reactionName(raw: string): string {
  const name = raw.replace(/^:/, "").replace(/:$/, "").toLowerCase()
  if (!/^[a-z0-9_+'-]+(::skin-tone-[2-6])?$/.test(name) || name.length > 100) throw new CampflareError("invalid_name")
  return name
}

async function react(ctx: Ctx<Actor>, added: boolean) {
  const { c, message } = await target(ctx)
  const name = reactionName(ctx.args.req("name", "invalid_name"))
  const user = ctx.auth.user.id
  const db = ctx.env.DB
  // The change and the audience in one batch. An added reaction must be one of at most
  // MAX_DISTINCT names on the message, or a name already there.
  const change = added
    ? stmt(
        db,
        `INSERT INTO reactions (channel_id, ts, name, user_id, created) SELECT ?, ?, ?, ?, ?
         WHERE (SELECT COUNT(DISTINCT name) FROM reactions WHERE channel_id = ?1 AND ts = ?2) < ?6
            OR EXISTS (SELECT 1 FROM reactions WHERE channel_id = ?1 AND ts = ?2 AND name = ?3)`,
        c.id,
        message.ts,
        name,
        user,
        Date.now(),
        MAX_DISTINCT,
      )
    : stmt(
        db,
        "DELETE FROM reactions WHERE channel_id = ? AND ts = ? AND name = ? AND user_id = ?",
        c.id,
        message.ts,
        name,
        user,
      )
  let results: D1Result[]
  try {
    results = await db.batch([change, audienceStatement(db, c.id)])
  } catch (error) {
    if (added && isUniqueViolation(error)) throw new CampflareError("already_reacted")
    throw error
  }
  if (!results[0]!.meta.changes) throw new CampflareError(added ? "too_many_reactions" : "no_reaction")
  publish(ctx, {
    teamId: c.team_id,
    audience: audienceFrom(results[1]!),
    event: {
      type: added ? "reaction_added" : "reaction_removed",
      user,
      reaction: name,
      item: { type: "message", channel: c.id, ts: message.ts },
      ...(message.user_id ? { item_user: message.user_id } : {}),
      event_ts: `${(Date.now() / 1000).toFixed(6)}`,
    },
  })
  return {}
}

method("reactions.add", "actor", (ctx) => react(ctx, true))
method("reactions.remove", "actor", (ctx) => react(ctx, false))

method("reactions.get", "actor", async (ctx) => {
  const { c, message } = await target(ctx)
  return {
    type: "message",
    channel: c.id,
    message: {
      ...(await messageOut(ctx, message)),
      permalink: permalink(ctx.origin, c.id, message.ts, message.thread_ts),
    },
  }
})
