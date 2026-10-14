import { all, first, isUniqueViolation, run, stmt } from "../db/query"
import type { AppRow, TokenRow, UserRow } from "../db/rows"
import { APP_SCOPES, DEFAULT_BOT_SCOPES, DEFAULT_USER_SCOPES, issueToken } from "../api/auth"
import { method, type Actor, type Ctx } from "../api/context"
import { invalidArguments, CampflareError } from "../api/errors"
import { ids, nowSeconds, randomSecret } from "../api/ids"
import { teamJson, userJson } from "../api/shapes"
import { checkPassword, setPassword } from "../auth/password"
import type { Env } from "../env"
import { EVENT_TYPE } from "../app-events"
import { requestUrlProblem, verifyRequestUrl } from "../request-url"

// campflare.* — what Slack does in its admin UI and OAuth flow, as API
// methods: creating a workspace, people, tokens and apps. Not part of the
// Slack-compatible surface, and named so they can't collide with it.

function requireAdmin(ctx: Ctx<Actor>) {
  if (ctx.auth.kind !== "user" || !ctx.auth.user.is_admin) throw new CampflareError("not_allowed_token_type")
}

const HANDLE = /^[a-z0-9][a-z0-9._-]{0,79}$/

async function createUser(
  env: Env,
  teamId: string,
  opts: { name: string; realName?: string; email?: string; admin?: boolean; owner?: boolean; bot?: string },
): Promise<UserRow> {
  const name = opts.name.toLowerCase()
  if (!HANDLE.test(name)) throw new CampflareError("invalid_name")
  const now = nowSeconds()
  const id = ids.user()
  try {
    await run(
      env.DB,
      `INSERT INTO users (id, team_id, name, real_name, display_name, email, is_admin, is_owner, is_bot, bot_id, updated, created)
       VALUES (?, ?, ?, ?, '', ?, ?, ?, ?, ?, ?, ?)`,
      id,
      teamId,
      name,
      opts.realName ?? "",
      opts.email?.toLowerCase() ?? null,
      opts.admin || opts.owner ? 1 : 0,
      opts.owner ? 1 : 0,
      opts.bot ? 1 : 0,
      opts.bot ?? null,
      now,
      now,
    )
  } catch (error) {
    if (isUniqueViolation(error)) throw new CampflareError(opts.email ? "already_in_team" : "name_taken")
    throw error
  }
  // Everyone is in #general, as in Slack.
  await run(
    env.DB,
    `INSERT OR IGNORE INTO members (conversation_id, user_id, joined)
     SELECT id, ?, ? FROM conversations WHERE team_id = ? AND is_general = 1`,
    id,
    now,
    teamId,
  )
  return (await first<UserRow>(env.DB, "SELECT * FROM users WHERE id = ?", id))!
}

/**
 * Creates a workspace with its owner and #general, and returns the owner's
 * token. Needs BOOTSTRAP_SECRET; unset it to close sign-up.
 */
method("campflare.bootstrap", "none", async (ctx) => {
  const secret = ctx.env.BOOTSTRAP_SECRET
  if (!secret || ctx.args.str("secret") !== secret) throw new CampflareError("not_allowed")
  const teamName = ctx.args.req("team_name")
  const domain = (ctx.args.str("domain") ?? teamName)
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-|-$/g, "")
  if (!domain) throw invalidArguments("domain must have letters or digits")
  const teamId = ids.team()
  const now = nowSeconds()
  try {
    await run(
      ctx.env.DB,
      "INSERT INTO teams (id, name, domain, created) VALUES (?, ?, ?, ?)",
      teamId,
      teamName,
      domain,
      now,
    )
  } catch (error) {
    if (isUniqueViolation(error)) throw new CampflareError("domain_taken")
    throw error
  }
  const owner = await createUser(ctx.env, teamId, {
    name: ctx.args.req("user_name"),
    realName: ctx.args.str("real_name"),
    email: ctx.args.str("email"),
    owner: true,
  })
  const general = ids.channel()
  await ctx.env.DB.batch([
    stmt(
      ctx.env.DB,
      `INSERT INTO conversations (id, team_id, kind, name, is_general, creator, purpose, purpose_creator, purpose_last_set, created, updated)
       VALUES (?, ?, 'channel', 'general', 1, ?, 'This is the one channel that will always include everyone.', ?, ?, ?, ?)`,
      general,
      teamId,
      owner.id,
      owner.id,
      now,
      now,
      now,
    ),
    stmt(ctx.env.DB, "INSERT INTO members (conversation_id, user_id, joined) VALUES (?, ?, ?)", general, owner.id, now),
  ])
  const token = await issueToken(ctx.env, {
    teamId,
    kind: "user",
    userId: owner.id,
    scopes: DEFAULT_USER_SCOPES,
    label: "bootstrap",
  })
  const team = { id: teamId, name: teamName, domain, created: now }
  return { team: teamJson(team, ctx.origin), user: userJson(owner, ctx.origin), token, general_channel: general }
})

/** Adds a person to the workspace and returns their first user token. */
method("campflare.users.create", "user", async (ctx) => {
  requireAdmin(ctx)
  // An initial password is optional; it needs an email to sign in with.
  const password = ctx.args.str("password")
  if (password !== undefined) {
    checkPassword(password)
    if (!ctx.args.has("email")) throw new CampflareError("email_required")
  }
  const user = await createUser(ctx.env, ctx.auth.team.id, {
    name: ctx.args.req("name"),
    realName: ctx.args.str("real_name"),
    email: ctx.args.str("email"),
    admin: ctx.args.bool("is_admin"),
  })
  const [token] = await Promise.all([
    issueToken(ctx.env, {
      teamId: ctx.auth.team.id,
      kind: "user",
      userId: user.id,
      scopes: DEFAULT_USER_SCOPES,
      label: "created by admin",
    }),
    password === undefined ? undefined : setPassword(ctx.env, user, password),
  ])
  return { user: userJson(user, ctx.origin), token }
})

/**
 * Sets the caller's own password, for signing in at /login with their email
 * address. The user token proves who they are; the password is never returned.
 */
method("campflare.users.setPassword", "user", async (ctx) => {
  const password = ctx.args.req("password")
  if (!ctx.auth.user.email) throw new CampflareError("email_required")
  await setPassword(ctx.env, ctx.auth.user, password)
  return {}
})

method("campflare.users.deactivate", "user", async (ctx) => {
  requireAdmin(ctx)
  const id = ctx.args.req("user", "user_not_found")
  if (id === ctx.auth.user.id) throw new CampflareError("cant_deactivate_self")
  const res = await run(
    ctx.env.DB,
    "UPDATE users SET deleted = 1, updated = ? WHERE id = ? AND team_id = ? AND is_owner = 0 AND deleted = 0",
    nowSeconds(),
    id,
    ctx.auth.team.id,
  )
  if (!res.meta.changes) throw new CampflareError("user_not_found")
  await run(ctx.env.DB, "UPDATE tokens SET revoked = 1 WHERE user_id = ?", id)
  return {}
})

/** Another user token for yourself (one per device or script), or for anyone if you're an admin. */
method("campflare.tokens.create", "user", async (ctx) => {
  const userId = ctx.args.str("user") ?? ctx.auth.user.id
  if (userId !== ctx.auth.user.id) requireAdmin(ctx)
  const user = await first<UserRow>(
    ctx.env.DB,
    "SELECT * FROM users WHERE id = ? AND team_id = ? AND deleted = 0 AND is_bot = 0",
    userId,
    ctx.auth.team.id,
  )
  if (!user) throw new CampflareError("user_not_found")
  const token = await issueToken(ctx.env, {
    teamId: ctx.auth.team.id,
    kind: "user",
    userId,
    scopes: DEFAULT_USER_SCOPES,
    label: ctx.args.str("label") ?? "",
  })
  return { token, user_id: userId }
})

method("campflare.tokens.list", "user", async (ctx) => {
  const rows = await all<TokenRow>(
    ctx.env.DB,
    "SELECT * FROM tokens WHERE team_id = ? AND user_id = ? AND revoked = 0 ORDER BY created",
    ctx.auth.team.id,
    ctx.auth.user.id,
  )
  // The hash's prefix identifies a token for revoking without revealing it.
  return { tokens: rows.map((t) => ({ id: t.hash.slice(0, 16), kind: t.kind, label: t.label, created: t.created })) }
})

method("campflare.tokens.revoke", "user", async (ctx) => {
  const id = ctx.args.req("id")
  if (!/^[0-9a-f]{16}$/.test(id)) throw invalidArguments("id is the 16-character id from campflare.tokens.list")
  const res = await run(
    ctx.env.DB,
    "UPDATE tokens SET revoked = 1 WHERE team_id = ? AND user_id = ? AND substr(hash, 1, 16) = ?",
    ctx.auth.team.id,
    ctx.auth.user.id,
    id,
  )
  return { revoked: res.meta.changes > 0 }
})

/**
 * Creates an app installed by you: a bot user with a bot token (xoxb-), and
 * an app-level token (xapp-) for Socket Mode, which delivers your events
 * (as a user-token install would) and the bot's.
 */
method("campflare.apps.create", "user", async (ctx) => {
  const name = ctx.args.req("name")
  const handle =
    ctx.args.str("bot_name") ??
    name
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, "-")
      .replace(/^-|-$/g, "")
  const appId = ids.app()
  const botId = ids.bot()
  const botUser = await createUser(ctx.env, ctx.auth.team.id, { name: handle || "bot", realName: name, bot: botId })
  await run(
    ctx.env.DB,
    `INSERT INTO apps (id, team_id, name, bot_id, bot_user_id, installer_user_id, created, signing_secret)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    appId,
    ctx.auth.team.id,
    name,
    botId,
    botUser.id,
    ctx.auth.user.id,
    nowSeconds(),
    randomSecret(16),
  )
  const [botToken, appToken] = await Promise.all([
    issueToken(ctx.env, {
      teamId: ctx.auth.team.id,
      kind: "bot",
      userId: botUser.id,
      appId,
      scopes: DEFAULT_BOT_SCOPES,
    }),
    issueToken(ctx.env, { teamId: ctx.auth.team.id, kind: "app", appId, scopes: APP_SCOPES }),
  ])
  const app = (await first<AppRow>(ctx.env.DB, "SELECT * FROM apps WHERE id = ?", appId))!
  return {
    app: { id: app.id, name: app.name, bot_id: app.bot_id, bot_user_id: app.bot_user_id },
    bot_token: botToken,
    app_token: appToken,
    signing_secret: app.signing_secret,
  }
})

/** An app's settings as its installer sees them, signing secret included. */
function appSettings(app: AppRow) {
  return {
    id: app.id,
    name: app.name,
    bot_id: app.bot_id,
    bot_user_id: app.bot_user_id,
    installer_user_id: app.installer_user_id,
    signing_secret: app.signing_secret,
    event_subscriptions: {
      request_url: app.event_request_url,
      events: app.event_types ? (JSON.parse(app.event_types) as string[]) : null,
    },
    interactivity: { request_url: app.interactivity_request_url },
  }
}

/** An app of the caller's workspace that they installed, or any if they're an admin. */
async function ownApp(ctx: Ctx<Actor>): Promise<AppRow> {
  const app = await first<AppRow>(
    ctx.env.DB,
    "SELECT * FROM apps WHERE id = ? AND team_id = ?",
    ctx.args.req("app", "app_not_found"),
    ctx.auth.team.id,
  )
  if (!app) throw new CampflareError("app_not_found")
  if (app.installer_user_id !== ctx.auth.user.id && !ctx.auth.user.is_admin) throw new CampflareError("not_allowed")
  return app
}

/** An app's settings: its signing secret, Request URL and subscribed events. */
method("campflare.apps.info", "user", async (ctx) => ({ app: appSettings(await ownApp(ctx)) }))

/**
 * Sets where and which events an app receives over HTTP (Slack's Event
 * Subscriptions). `request_url` is checked with Slack's url_verification
 * challenge before it's saved; an empty one stops HTTP delivery. `events`
 * (comma-separated or a JSON array: "app_mention", "message.channels"…)
 * limits what the app receives, over Socket Mode too; empty means every event
 * it can see. Either may be left out to keep it.
 */
method("campflare.apps.setEventSubscriptions", "user", async (ctx) => {
  const app = await ownApp(ctx)
  const url = ctx.args.given("request_url") ? (ctx.args.str("request_url")?.trim() ?? "") : undefined
  const events = eventTypes(ctx)
  if (url === undefined && events === undefined) throw invalidArguments("give request_url, events or both")
  if (url) {
    const problem = requestUrlProblem(url)
    if (problem) throw invalidArguments(problem)
    const check = await verifyRequestUrl(url, app.signing_secret)
    if (!check.verified) {
      throw new CampflareError("url_verification_failed", {
        response_metadata: {
          messages: [
            check.status === 0
              ? `[ERROR] no answer from the Request URL (${check.reason})`
              : `[ERROR] the Request URL answered ${check.status} without echoing the challenge`,
          ],
        },
      })
    }
  }
  const updated = (await first<AppRow>(
    ctx.env.DB,
    `UPDATE apps SET event_request_url = CASE WHEN ?1 THEN ?2 ELSE event_request_url END,
       event_types = CASE WHEN ?3 THEN ?4 ELSE event_types END
     WHERE id = ?5 RETURNING *`,
    url !== undefined ? 1 : 0,
    url || null,
    events !== undefined ? 1 : 0,
    events?.length ? JSON.stringify(events) : null,
    app.id,
  ))!
  const hub = ctx.env.HUB.get(ctx.env.HUB.idFromName(ctx.auth.team.id))
  await hub.subscriptionsChanged()
  return { app: appSettings(updated) }
})

/**
 * Sets where clicks on the app's buttons are POSTed (Slack's Interactivity
 * Request URL): block_actions, form-encoded and signed like events. Slack
 * doesn't challenge this URL, so it's only checked for its form; an empty one
 * stops HTTP delivery. A Socket Mode link takes clicks whether it's set or not.
 */
method("campflare.apps.setInteractivity", "user", async (ctx) => {
  const app = await ownApp(ctx)
  if (!ctx.args.given("request_url")) throw invalidArguments("missing required field: request_url")
  const url = ctx.args.str("request_url")?.trim() ?? ""
  const problem = url ? requestUrlProblem(url) : undefined
  if (problem) throw invalidArguments(problem)
  const updated = (await first<AppRow>(
    ctx.env.DB,
    "UPDATE apps SET interactivity_request_url = ? WHERE id = ? RETURNING *",
    url || null,
    app.id,
  ))!
  return { app: appSettings(updated) }
})

/** `events` as a list (comma-separated or a JSON array), or undefined when not given. */
function eventTypes(ctx: Ctx<Actor>): string[] | undefined {
  if (!ctx.args.given("events")) return undefined
  const list: unknown = ctx.args.str("events")?.trim().startsWith("[")
    ? ctx.args.json<unknown>("events")
    : ctx.args.list("events")
  if (!Array.isArray(list) || !list.every((t) => typeof t === "string" && EVENT_TYPE.test(t))) {
    throw invalidArguments('events is a list of event types, like "app_mention,message.channels"')
  }
  return [...new Set(list as string[])]
}
