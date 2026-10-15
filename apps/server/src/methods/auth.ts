import { all, first, run } from "../db/query"
import type { AppRow, UserRow } from "../db/rows"
import { sha256Hex } from "../api/crypto"
import { method, methods, type Access } from "../api/context"
import { CampflareError } from "../api/errors"
import { acceptedScopes, NEEDS, PRESETS } from "../api/scopes"
import { teamJson } from "../api/shapes"
import { issueTicket, wsOrigin } from "../api/tickets"

method("api.test", "none", async (ctx) => {
  const args = { ...ctx.args.values }
  delete args.token
  if (ctx.args.str("error")) throw new CampflareError(ctx.args.str("error")!, { args })
  return Object.keys(args).length > 0 ? { args } : {}
})

const TOKEN_KINDS: Record<Access, string[]> = {
  user: ["user"],
  bot: ["bot"],
  actor: ["user", "bot"],
  app: ["app"],
  none: [],
}

/**
 * Every method, with the token types it takes and the scopes it accepts (any
 * one will do; a conversation method also wants the one for the
 * conversation's type), and what each preset holds. No token needed: an agent
 * checks its plan against its token's scopes (x-oauth-scopes) before acting.
 */
method("campflare.methods.list", "none", async () => ({
  methods: [...methods]
    .map(([name, def]) => {
      const need = NEEDS[name] ?? []
      return {
        name,
        tokens: TOKEN_KINDS[def.access],
        scopes: acceptedScopes(need),
        ...("conversation" in need ? { conversation_scope: need.conversation } : {}),
        ...("all" in need ? { scopes_required: "all" } : {}),
      }
    })
    .toSorted((a, b) => a.name.localeCompare(b.name)),
  presets: PRESETS,
}))

method("auth.test", "actor", async (ctx) => {
  const { team, user, app, kind } = ctx.auth
  return {
    url: `${ctx.origin}/`,
    team: team.name,
    user: user.name,
    team_id: team.id,
    user_id: user.id,
    ...(kind === "bot" && app ? { bot_id: app.bot_id, app_id: app.id } : {}),
    is_enterprise_install: false,
  }
})

method("auth.revoke", "actor", async (ctx) => {
  if (ctx.args.bool("test")) return { revoked: false }
  const token = ctx.request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? ctx.args.str("token")
  if (token) await run(ctx.env.DB, "UPDATE tokens SET revoked = 1 WHERE hash = ?", await sha256Hex(token))
  return { revoked: true }
})

method("team.info", "actor", async (ctx) => {
  return { team: teamJson(ctx.auth.team, ctx.origin) }
})

method("bots.info", "actor", async (ctx) => {
  const botId = ctx.args.req("bot")
  const app = await first<AppRow>(
    ctx.env.DB,
    "SELECT * FROM apps WHERE bot_id = ? AND team_id = ?",
    botId,
    ctx.auth.team.id,
  )
  if (!app) throw new CampflareError("bot_not_found")
  return {
    bot: {
      id: app.bot_id,
      deleted: false,
      name: app.name,
      updated: app.created,
      app_id: app.id,
      user_id: app.bot_user_id,
      icons: {},
    },
  }
})

/** Socket Mode: a WebSocket URL for the app's events. */
method("apps.connections.open", "app", async (ctx) => {
  const app = ctx.auth.app
  if (!app) throw new CampflareError("invalid_auth")
  const ticket = await issueTicket(ctx.env.SIGNING_KEY, {
    kind: "socket",
    teamId: app.team_id,
    appId: app.id,
    users: [app.installer_user_id, app.bot_user_id],
    botUserId: app.bot_user_id,
    installerUserId: app.installer_user_id,
  })
  return { url: `${wsOrigin(ctx.origin)}/link/?ticket=${ticket}&app_id=${app.id}` }
})

/** RTM: a WebSocket URL carrying every event the token's user can see. */
method("rtm.connect", "actor", async (ctx) => {
  const { team, user } = ctx.auth
  const ticket = await issueTicket(ctx.env.SIGNING_KEY, { kind: "rtm", teamId: team.id, users: [user.id] })
  return {
    url: `${wsOrigin(ctx.origin)}/link/?ticket=${ticket}`,
    team: { id: team.id, name: team.name, domain: team.domain },
    self: { id: user.id, name: user.name },
  }
})

method("apps.list", "user", async (ctx) => {
  const apps = await all<AppRow & Pick<UserRow, "name">>(
    ctx.env.DB,
    "SELECT * FROM apps WHERE team_id = ? ORDER BY created",
    ctx.auth.team.id,
  )
  return { apps: apps.map((a) => ({ id: a.id, name: a.name, bot_id: a.bot_id, bot_user_id: a.bot_user_id })) }
})
