import { DEFAULT_BOT_SCOPES } from "./api/auth"
import { Args } from "./api/args"
import type { Actor, Ctx } from "./api/context"
import { openConversation } from "./db/conversations"
import { postMessage } from "./db/messages"
import { first } from "./db/query"
import type { AppRow, TeamRow, UserRow } from "./db/rows"
import { HEALTH_WINDOW_MINUTES } from "./delivery-health"
import type { Env } from "./env"
import type { PostResult } from "./request-url"

// Turning off HTTP event delivery for an app whose Request URL keeps failing,
// as Slack does: recorded on the app (migration 0015), and told to its
// installer in a DM from the app's own bot user, which they know and which
// every app has.

/** Why, in a sentence: the share that failed and how the last one did. */
export function disabledReason(
  totals: { attempts: number; failures: number },
  last: Pick<PostResult, "status" | "reason">,
) {
  const share = Math.floor((totals.failures / totals.attempts) * 100)
  const how = last.status === 0 ? `no answer (${last.reason})` : `HTTP ${last.status}`
  return `${share}% of ${totals.attempts} attempts in the last ${HEALTH_WINDOW_MINUTES} minutes failed; the last: ${how}`
}

/**
 * Marks the app's delivery off, unless its Request URL changed meanwhile or
 * it is already off. Returns the app as it is now, or undefined when nothing
 * changed (so one failing URL is reported once, however many attempts trip).
 */
export async function disableDelivery(env: Env, appId: string, url: string, reason: string) {
  return first<AppRow>(
    env.DB,
    `UPDATE apps SET event_delivery_disabled_at = ?, event_delivery_disabled_reason = ?
     WHERE id = ? AND event_request_url = ? AND event_delivery_disabled_at IS NULL RETURNING *`,
    Math.floor(Date.now() / 1000),
    reason,
    appId,
    url,
  )
}

/** The DM to the installer, from the app's bot. */
export async function tellInstaller(
  env: Env,
  app: AppRow,
  { origin, waitUntil }: { origin: string; waitUntil: (p: Promise<unknown>) => void },
) {
  const [team, bot, installer] = await Promise.all([
    first<TeamRow>(env.DB, "SELECT * FROM teams WHERE id = ?", app.team_id),
    first<UserRow>(env.DB, "SELECT * FROM users WHERE id = ?", app.bot_user_id),
    first<UserRow>(env.DB, "SELECT * FROM users WHERE id = ? AND deleted = 0", app.installer_user_id),
  ])
  if (!team || !bot || !installer) return
  const ctx: Ctx<Actor> = {
    env,
    args: new Args({}),
    auth: { kind: "bot", team, user: bot, app, scopes: DEFAULT_BOT_SCOPES },
    request: new Request(origin),
    origin,
    waitUntil,
  }
  const dm = await openConversation(ctx, [installer.id])
  const text =
    `:warning: Campflare turned off event delivery for *${app.name}* (${app.id}): ` +
    `${app.event_delivery_disabled_reason}. Events for ${app.event_request_url} are no longer sent or retried.\n` +
    `Once the app answers again, set its Request URL again to turn delivery back on ` +
    `(it is checked with url_verification): \`campflare admin app ${app.id} --request-url ${app.event_request_url}\``
  await postMessage(ctx, dm, { user_id: bot.id, bot_id: app.bot_id, app_id: app.id, text })
}
