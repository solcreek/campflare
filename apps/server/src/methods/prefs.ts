import { requireReadable, resolveConversation } from "../db/conversations"
import { stmt } from "../db/query"
import type { NotificationLevel, NotificationPrefRow } from "../db/rows"
import { publish } from "../events"
import { method, type Actor, type Ctx } from "../api/context"
import { invalidArguments } from "../api/errors"
import { nowSeconds } from "../api/ids"

// A person's own preferences (docs/activity.md). For now: notification levels,
// per conversation and a default, which decide each activity item's `notify`.

const LEVELS: readonly NotificationLevel[] = ["all", "mentions", "none"]

/** What a level is when nothing is set: activity items are already worth attention. */
export const DEFAULT_LEVEL: NotificationLevel = "all"

/** The prefs as the API answers them, from the person's rows. */
function prefsJson(rows: Pick<NotificationPrefRow, "conversation_id" | "level">[]) {
  const own = rows.find((r) => r.conversation_id === "")
  return {
    notifications: {
      default: own?.level ?? DEFAULT_LEVEL,
      conversations: Object.fromEntries(
        rows.filter((r) => r.conversation_id !== "").map((r) => [r.conversation_id, r.level]),
      ),
    },
  }
}

const prefsStatement = (ctx: Ctx<Actor>) =>
  stmt(
    ctx.env.DB,
    "SELECT conversation_id, level FROM notification_prefs WHERE user_id = ? ORDER BY conversation_id",
    ctx.auth.user.id,
  )

method("campflare.prefs.get", "user", async (ctx) => {
  const { results } = await prefsStatement(ctx).all<NotificationPrefRow>()
  return { prefs: prefsJson(results) }
})

method("campflare.prefs.set", "user", async (ctx) => {
  const level = ctx.args.req("level")
  if (level !== "default" && !LEVELS.includes(level as NotificationLevel)) {
    throw invalidArguments("level must be all, mentions, none or default")
  }
  const ref = ctx.args.str("channel")
  let conversationId = ""
  if (ref) {
    const c = await resolveConversation(ctx, ref)
    await requireReadable(ctx, c)
    conversationId = c.id
  }
  const db = ctx.env.DB
  const user = ctx.auth.user.id
  const change =
    level === "default"
      ? stmt(db, "DELETE FROM notification_prefs WHERE user_id = ? AND conversation_id = ?", user, conversationId)
      : stmt(
          db,
          `INSERT INTO notification_prefs (user_id, conversation_id, level, updated) VALUES (?, ?, ?, ?)
           ON CONFLICT (user_id, conversation_id) DO UPDATE SET level = excluded.level, updated = excluded.updated`,
          user,
          conversationId,
          level,
          nowSeconds(),
        )
  const [, rows] = await db.batch([change, prefsStatement(ctx)])
  const prefs = prefsJson(rows!.results as NotificationPrefRow[])
  // The person's other clients show the same.
  publish(ctx, { teamId: ctx.auth.team.id, audience: [user], rtmOnly: true, event: { type: "prefs_changed", prefs } })
  return { prefs }
})
