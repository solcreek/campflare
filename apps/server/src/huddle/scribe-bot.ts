import { DEFAULT_BOT_SCOPES } from "../api/auth"
import type { Actor } from "../api/context"
import { ids, nowSeconds } from "../api/ids"
import { first, isUniqueViolation, run, stmt } from "../db/query"
import type { AppRow, TeamRow, UserRow } from "../db/rows"
import type { Env } from "../env"

export const SCRIBE_NAME = "Huddle Scribe"
const HANDLE = "huddle-scribe"

/**
 * The bot that posts transcripts: one per workspace, made on first use, an
 * ordinary app with a bot user (it has no tokens: only the Worker acts as it).
 */
export async function scribeActor(env: Env, team: TeamRow): Promise<Actor> {
  let app = await first<AppRow>(env.DB, "SELECT * FROM apps WHERE team_id = ? AND name = ?", team.id, SCRIBE_NAME)
  if (!app) {
    const now = nowSeconds()
    const userId = ids.user()
    const botId = ids.bot()
    const appId = ids.app()
    try {
      await env.DB.batch([
        stmt(
          env.DB,
          `INSERT INTO users (id, team_id, name, real_name, is_bot, bot_id, updated, created) VALUES (?, ?, ?, ?, 1, ?, ?, ?)`,
          userId,
          team.id,
          HANDLE,
          SCRIBE_NAME,
          botId,
          now,
          now,
        ),
        stmt(
          env.DB,
          "INSERT INTO apps (id, team_id, name, bot_id, bot_user_id, installer_user_id, created) VALUES (?, ?, ?, ?, ?, ?, ?)",
          appId,
          team.id,
          SCRIBE_NAME,
          botId,
          userId,
          userId,
          now,
        ),
      ])
    } catch (error) {
      // Made concurrently by another request: use theirs.
      if (!isUniqueViolation(error)) throw error
    }
    app = (await first<AppRow>(env.DB, "SELECT * FROM apps WHERE team_id = ? AND name = ?", team.id, SCRIBE_NAME))!
  }
  const user = (await first<UserRow>(env.DB, "SELECT * FROM users WHERE id = ?", app.bot_user_id))!
  return { kind: "bot", team, user, app, scopes: DEFAULT_BOT_SCOPES }
}

/** Puts the bot in a conversation it must post to (private channels and DMs included). */
export async function seatScribe(env: Env, conversationId: string, botUserId: string) {
  await run(
    env.DB,
    "INSERT OR IGNORE INTO members (conversation_id, user_id, joined) VALUES (?, ?, ?)",
    conversationId,
    botUserId,
    nowSeconds(),
  )
}
