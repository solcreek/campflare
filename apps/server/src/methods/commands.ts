import { all, isUniqueViolation, stmt } from "../db/query"
import { requireWritable, resolveConversation } from "../db/conversations"
import type { AppRow, UserRow } from "../db/rows"
import { method, type Actor, type Ctx } from "../api/context"
import { CampflareError, invalidArguments } from "../api/errors"
import { nowSeconds } from "../api/ids"
import { requireScope } from "../api/scopes"
import { COMMAND_NAME, commandJson, commandSettings, invokeCommand, type CommandRow } from "../commands"
import { publish } from "../events"
import { requestUrlProblem } from "../request-url"
import { ownApp } from "./admin"

// Slash commands (docs/commands-webhooks.md): apps register them, people run them.

const MAX_COMMANDS = 50

interface CommandInput {
  name: string
  description: string
  usage_hint: string
  url: string | null
}

/** `commands` as given: a JSON array of { command, description?, usage_hint?, url? }. */
function commandsOf(ctx: Ctx<Actor>): CommandInput[] {
  const given = ctx.args.json<unknown>("commands")
  if (given === undefined) return []
  if (!Array.isArray(given) || given.length > MAX_COMMANDS) {
    throw invalidArguments(
      `commands is a JSON array of at most ${MAX_COMMANDS} { command, description, usage_hint, url }`,
    )
  }
  const seen = new Set<string>()
  return given.map((entry: unknown) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw invalidArguments("each command is an object")
    const e = entry as Record<string, unknown>
    const name = typeof e.command === "string" ? e.command.trim() : ""
    if (!COMMAND_NAME.test(name)) {
      throw invalidArguments(`"${name}": a command is a slash and up to 31 lower-case letters, digits, - or _`)
    }
    if (seen.has(name)) throw invalidArguments(`${name} is given twice`)
    seen.add(name)
    const text = (key: string, max: number) => {
      const v = e[key]
      if (v === undefined || v === null) return ""
      if (typeof v !== "string" || v.length > max) throw invalidArguments(`${key} is text of at most ${max} characters`)
      return v.trim()
    }
    const url = text("url", 2000) || null
    const problem = url ? requestUrlProblem(url) : undefined
    if (problem) throw invalidArguments(problem.replace("request_url", `${name}'s url`))
    return { name, description: text("description", 200), usage_hint: text("usage_hint", 100), url }
  })
}

/**
 * Replaces an app's slash commands (Slack's manifest `features.slash_commands`).
 * `commands` is a JSON array of { command: "/deploy", description, usage_hint,
 * url }; empty or left out removes them all. `url` is where a command is
 * POSTed when the app has no Socket Mode link. A name is the workspace's: one
 * held by another app is `command_taken`, unless that app's bot was
 * deactivated, whose commands give way. The installer or an admin, with a
 * user token (apps:write); or the app itself, with its bot token (commands).
 */
method("campflare.apps.setCommands", "actor", async (ctx) => {
  let app: AppRow
  if (ctx.auth.kind === "bot") {
    requireScope(ctx.auth, ["commands"])
    const own = ctx.auth.app
    const id = ctx.args.str("app") ?? own?.id
    if (!own || id !== own.id) throw new CampflareError("app_not_found")
    app = own
  } else {
    requireScope(ctx.auth, ["apps:write"])
    app = await ownApp(ctx)
  }
  const commands = commandsOf(ctx)
  const names = JSON.stringify(commands.map((c) => c.name))
  const db = ctx.env.DB
  const now = nowSeconds()
  try {
    await db.batch([
      // A deactivated app's commands give way to a live one's.
      stmt(
        db,
        `DELETE FROM app_commands WHERE team_id = ? AND name IN (SELECT value FROM json_each(?))
           AND app_id IN (SELECT a.id FROM apps a JOIN users u ON u.id = a.bot_user_id WHERE u.deleted = 1)`,
        app.team_id,
        names,
      ),
      stmt(db, "DELETE FROM app_commands WHERE app_id = ?", app.id),
      ...commands.map((c) =>
        stmt(
          db,
          `INSERT INTO app_commands (team_id, name, app_id, description, usage_hint, url, created)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          app.team_id,
          c.name,
          app.id,
          c.description,
          c.usage_hint,
          c.url,
          now,
        ),
      ),
    ])
  } catch (error) {
    if (!isUniqueViolation(error)) throw error
    const taken = await all<{ name: string }>(
      db,
      "SELECT name FROM app_commands WHERE team_id = ? AND app_id != ? AND name IN (SELECT value FROM json_each(?))",
      app.team_id,
      app.id,
      names,
    )
    throw new CampflareError("command_taken", {
      response_metadata: { messages: taken.map((t) => `[ERROR] ${t.name} belongs to another app`) },
    })
  }
  // Clients refresh their command lists, as on Slack's commands_changed.
  publish(ctx, {
    teamId: app.team_id,
    audience: "team",
    rtmOnly: true,
    event: { type: "commands_changed", event_ts: `${(Date.now() / 1000).toFixed(6)}` },
  })
  return {
    app_id: app.id,
    commands: commands.map((c) => commandSettings({ ...c, app_id: app.id })),
  }
})

/** The workspace's slash commands, of apps whose bot is active: for a composer's autocompletion. */
method("campflare.commands.list", "user", async (ctx) => {
  const rows = await all<CommandRow & { app_name: string }>(
    ctx.env.DB,
    `SELECT c.*, a.name AS app_name FROM app_commands c
       JOIN apps a ON a.id = c.app_id JOIN users u ON u.id = a.bot_user_id
     WHERE c.team_id = ? AND u.deleted = 0 ORDER BY c.name`,
    ctx.auth.team.id,
  )
  return { commands: rows.map(commandJson) }
})

/**
 * Runs a slash command, as typing `/deploy staging` in the composer does:
 * `channel`, `command` ("/deploy") and `text` ("staging"). The person must
 * be able to post in the conversation. Answers how it reached the app and
 * what the app answered at once (`response`), which is also shown: to the
 * person alone, or posted in the conversation.
 */
method("campflare.commands.invoke", "user", async (ctx) => {
  const c = await resolveConversation(ctx, ctx.args.req("channel", "channel_not_found"))
  await requireWritable(ctx, c)
  const name = ctx.args.req("command", "command_not_found").trim().toLowerCase()
  const db = ctx.env.DB
  const [commands, apps, bots] = await db.batch([
    stmt(db, "SELECT * FROM app_commands WHERE team_id = ? AND name = ?", c.team_id, name),
    stmt(
      db,
      "SELECT * FROM apps WHERE id = (SELECT app_id FROM app_commands WHERE team_id = ? AND name = ?)",
      c.team_id,
      name,
    ),
    stmt(
      db,
      `SELECT * FROM users WHERE deleted = 0 AND id = (SELECT bot_user_id FROM apps
         WHERE id = (SELECT app_id FROM app_commands WHERE team_id = ? AND name = ?))`,
      c.team_id,
      name,
    ),
  ])
  const command = commands!.results[0] as CommandRow | undefined
  const app = apps!.results[0] as AppRow | undefined
  const bot = bots!.results[0] as UserRow | undefined
  if (!command || !app || !bot) throw new CampflareError("command_not_found")
  return { ...(await invokeCommand(ctx, c, { command, app, bot }, ctx.args.str("text")?.trim() ?? "")) }
})
