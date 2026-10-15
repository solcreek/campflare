import { DEFAULT_BOT_SCOPES } from "./api/scopes"
import { Args } from "./api/args"
import type { Actor, Ctx } from "./api/context"
import { ids, nowSeconds, randomId } from "./api/ids"
import { openConversation } from "./db/conversations"
import { postMessage } from "./db/messages"
import { first, isUniqueViolation, stmt } from "./db/query"
import type { AppRow, TeamRow, UserRow } from "./db/rows"
import type { Env } from "./env"

// The workspace's own bot, which reminders and notices come from (as Slack's
// come from Slackbot): an ordinary app with a bot user and no tokens, made on
// first use. Found by apps.built_in, never by name, so an app someone names
// "Campflare" can't stand in for it and read what it sends.

export const SYSTEM_BOT_NAME = "Campflare"
const BUILT_IN = "campflare"
const HANDLE = "campflare"

const findApp = (env: Env, teamId: string) =>
  first<AppRow>(env.DB, "SELECT * FROM apps WHERE team_id = ? AND built_in = ?", teamId, BUILT_IN)

/** The built-in bot as an actor, made if the workspace has none yet. */
export async function systemActor(env: Env, team: TeamRow): Promise<Actor> {
  let app = await findApp(env, team.id)
  // A person may already have the handle: then another, with a suffix.
  for (let attempt = 0; !app && attempt < 3; attempt++) {
    const now = nowSeconds()
    const userId = ids.user()
    const botId = ids.bot()
    const handle = attempt === 0 ? HANDLE : `${HANDLE}-${randomId("", 4).toLowerCase()}`
    try {
      await env.DB.batch([
        stmt(
          env.DB,
          `INSERT INTO users (id, team_id, name, real_name, is_bot, bot_id, updated, created) VALUES (?, ?, ?, ?, 1, ?, ?, ?)`,
          userId,
          team.id,
          handle,
          SYSTEM_BOT_NAME,
          botId,
          now,
          now,
        ),
        stmt(
          env.DB,
          `INSERT INTO apps (id, team_id, name, bot_id, bot_user_id, installer_user_id, created, built_in)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          ids.app(),
          team.id,
          SYSTEM_BOT_NAME,
          botId,
          userId,
          userId,
          now,
          BUILT_IN,
        ),
      ])
    } catch (error) {
      // Made concurrently by another request (theirs is the one), or the handle is taken.
      if (!isUniqueViolation(error)) throw error
    }
    app = await findApp(env, team.id)
  }
  if (!app) throw new Error("could not make the built-in bot")
  const user = (await first<UserRow>(env.DB, "SELECT * FROM users WHERE id = ?", app.bot_user_id))!
  return { kind: "bot", team, user, app, scopes: DEFAULT_BOT_SCOPES }
}

/** A request context acting as `auth`, for work the server does with no request (an alarm). */
export function serverCtx(env: Env, auth: Actor, origin: string, waitUntil: (p: Promise<unknown>) => void): Ctx<Actor> {
  return { env, args: new Args({}), auth, request: new Request(origin), origin, waitUntil }
}

/** A DM from the built-in bot to a person; `also` commits with it (postMessage). */
export async function dmFromSystem(ctx: Ctx<Actor>, userId: string, text: string, also: D1PreparedStatement[] = []) {
  const bot = ctx.auth
  const dm = await openConversation(ctx, [userId])
  return postMessage(ctx, dm, { user_id: bot.user.id, bot_id: bot.app!.bot_id, app_id: bot.app!.id, text }, also)
}
