import type { AppRow, TeamRow, UserRow } from "../db/rows"
import type { Env } from "../env"
import type { Args } from "./args"
import type { Actor, Ctx } from "./context"
import { publicOrigin } from "./origin"
import { DEFAULT_BOT_SCOPES } from "./scopes"

/**
 * A context in which the server acts as an app's bot, for what the app asked
 * of it without a token: a response_url's answer, a slash command's response,
 * an incoming webhook's message. Not checked for scopes (scopes-and-roles.md).
 */
export function asApp(
  env: Env,
  request: Request,
  waitUntil: (p: Promise<unknown>) => void,
  found: { team: TeamRow; app: AppRow; bot: UserRow },
  args: Args,
  origin = publicOrigin(request),
): Ctx<Actor> {
  return {
    env,
    args,
    auth: { kind: "bot", team: found.team, user: found.bot, app: found.app, scopes: DEFAULT_BOT_SCOPES },
    request,
    origin,
    waitUntil,
  }
}
