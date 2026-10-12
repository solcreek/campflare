import {
  ApiError,
  createClient,
  follow,
  listen,
  type ApiArgs,
  type Client,
  type RealtimeEvent,
} from "@campflare/client"
import { basename } from "node:path"
import { parseArgs, type ParseArgsConfig } from "node:util"
import { activeProfile, loadConfig, saveConfig, type Profile } from "./config"
import { messageLine, plain, time } from "./format"
import { UsageError, type Io } from "./io"
import { oauthLogin, revokeToken } from "./oauth"
import { resolveConversation, resolveUser, type Conversation, type User } from "./resolve"

const HELP = `campflare — the command line for Campflare (and any Slack-compatible API)

Usage: campflare <command> [options]

Account
  login --url <server> --token <xoxp-…> [--app-token <xapp-…>] [--profile <name>]
  login --url <server> --oauth [--port N]   sign in through the browser instead
  logout [--profile <name>]      forget the profile; revokes a token from login --oauth
  bootstrap --url <server> --secret <s> --team <name> --user <handle> [--email <e>]
  whoami                         who the token belongs to
  profiles                       list saved profiles; --use <name> switches
  password set                   set your password for signing in with your email (asks, or reads stdin)

Messages
  send <#channel|@person|id> [text] [--thread <ts>] [-f <file>]…   text from stdin if piped
  history <#channel|@person|id> [-n 20] [--thread <ts>] [--json]
  search <query> [-n 20] [--page N] [--newest] [--json]
  react <#channel|id> <ts> <emoji> [--remove]
  edit <#channel|id> <ts> <text>      delete <#channel|id> <ts>

Workspace
  channels [--all] [--json]        users [--json]
  create-channel <name> [--private]   join <#channel>   leave <#channel>
  invite <#channel> <@person>…
  listen [--json] [--socket]       stream live events (RTM, or Socket Mode with an app token)
  events [--cursor N] [--wait S] [--follow] [--json]
                                   the event log (Campflare): what came since a cursor, by polling
  api <method> [key=value]…        call any Web API method, print the JSON

Admin (Campflare only)
  admin add-user <handle> [--email <e>] [--name <real name>] [--admin]
  admin add-app <name>             a bot token and a Socket Mode app token
  token create [--label <l>]   token list   token revoke <id>

Global: --profile <name>, --json. Exit codes: 0 ok, 1 API error, 2 usage.`

type Values = Record<string, string | boolean | (string | boolean)[] | undefined>

const COMMON: ParseArgsConfig["options"] = {
  profile: { type: "string" },
  json: { type: "boolean" },
  help: { type: "boolean", short: "h" },
}

function parse(argv: string[], options: ParseArgsConfig["options"] = {}) {
  try {
    const { values, positionals } = parseArgs({
      args: argv,
      options: { ...COMMON, ...options },
      allowPositionals: true,
    })
    return { values: values as Values, positionals }
  } catch (error) {
    throw new UsageError(error instanceof Error ? error.message : String(error))
  }
}

const str = (v: Values[string]) => (typeof v === "string" ? v : undefined)

interface Session {
  io: Io
  profile: Profile
  client: Client
  self(): Promise<string>
  names(): Promise<Map<string, string>>
  conversation(ref: string): Promise<string>
  print(value: unknown): void
}

async function session(io: Io, values: Values): Promise<Session> {
  const profile = await activeProfile(io, str(values.profile))
  if (!profile.token) throw new UsageError("this profile has no token: run `campflare login`")
  const client = createClient({ url: profile.url, token: profile.token, fetch: io.fetch })
  let selfId: Promise<string> | undefined
  let names: Promise<Map<string, string>> | undefined
  const self = () => (selfId ??= client.call<{ ok: boolean; user_id: string }>("auth.test").then((r) => r.user_id))
  return {
    io,
    profile,
    client,
    self,
    names: () =>
      (names ??= client
        .paginate<User>("users.list", "members")
        .then((users) => new Map(users.map((u) => [u.id, u.profile?.display_name || u.name])))),
    conversation: (ref) => resolveConversation(client, ref, self),
    print: (value) => io.stdout(`${JSON.stringify(value, null, 2)}\n`),
  }
}

async function readStdin(io: Io): Promise<string | undefined> {
  const text = await io.stdin()
  return text?.replace(/\n$/, "")
}

/**
 * A login wrote over `old`: its token, if it came from `login --oauth` and isn't the new one,
 * is revoked rather than left working with nothing that knows it. Best effort.
 */
async function revokeReplaced(io: Io, old: Profile | undefined, token: string) {
  if (old?.via !== "oauth" || !old.token || old.token === token) return
  const res = await revokeToken(io, old.url, old.token)
  if (!res.revoked) {
    io.stderr(`Couldn't revoke the previous token at ${old.url} (${res.reason}); it works until revoked there\n`)
  }
}

type Command = (argv: string[], io: Io) => Promise<number | void>

const commands: Record<string, Command> = {
  async login(argv, io) {
    const { values } = parse(argv, {
      url: { type: "string" },
      token: { type: "string" },
      "app-token": { type: "string" },
      oauth: { type: "boolean" },
      port: { type: "string" },
    })
    const url = str(values.url) ?? io.env.CAMPFLARE_URL
    if (values.oauth && values.token) throw new UsageError("login takes --oauth or --token, not both")
    const port = str(values.port) === undefined ? undefined : Number(values.port)
    if (port !== undefined && !(Number.isInteger(port) && port >= 0 && port < 65536)) {
      throw new UsageError("--port is a port number")
    }
    if (values.oauth && !url) throw new UsageError("login --oauth needs --url")
    const token = values.oauth ? await oauthLogin(io, url!, { port }) : (str(values.token) ?? io.env.CAMPFLARE_TOKEN)
    if (!url || !token) throw new UsageError("login needs --url and --token (or --oauth)")
    const client = createClient({ url, token, fetch: io.fetch })
    const who = await client.call<{ ok: boolean; user: string; team: string }>("auth.test")
    const name = str(values.profile) ?? "default"
    const config = await loadConfig(io)
    const old = config.profiles[name]
    config.profiles[name] = {
      url,
      token,
      ...(str(values["app-token"]) ? { appToken: str(values["app-token"]) } : {}),
      via: values.oauth ? "oauth" : "token",
    }
    config.current = name
    await saveConfig(io, config)
    io.stdout(`Logged in to ${who.team} as @${who.user} (profile ${name})\n`)
    await revokeReplaced(io, old, token)
  },

  async logout(argv, io) {
    const { values } = parse(argv)
    const config = await loadConfig(io)
    const name = str(values.profile) ?? io.env.CAMPFLARE_PROFILE ?? config.current
    const profile = name ? config.profiles[name] : undefined
    if (!name || !profile) throw new UsageError(name ? `no profile named ${name}` : "not logged in")
    if (profile.via === "oauth" && profile.token) {
      const res = await revokeToken(io, profile.url, profile.token)
      if (res.revoked) io.stdout(`Revoked the token from signing in to ${profile.url}\n`)
      else io.stderr(`Couldn't revoke the token at ${profile.url} (${res.reason}); it works until revoked there\n`)
    } else if (profile.token) {
      io.stdout(
        "Not revoking the token: it was given by hand and may be in use elsewhere (`campflare token revoke` ends it)\n",
      )
    }
    delete config.profiles[name]
    if (config.current === name) delete config.current
    await saveConfig(io, config)
    io.stdout(`Logged out (profile ${name} forgotten)\n`)
  },

  async bootstrap(argv, io) {
    const { values } = parse(argv, {
      url: { type: "string" },
      secret: { type: "string" },
      team: { type: "string" },
      user: { type: "string" },
      email: { type: "string" },
      name: { type: "string" },
    })
    const url = str(values.url)
    if (!url || !values.secret || !values.team || !values.user) {
      throw new UsageError("bootstrap needs --url, --secret, --team and --user")
    }
    const res = await createClient({ url, fetch: io.fetch }).call<{
      ok: boolean
      token: string
      team: { name: string }
      user: { name: string }
    }>("campflare.bootstrap", {
      secret: str(values.secret),
      team_name: str(values.team),
      user_name: str(values.user),
      email: str(values.email),
      real_name: str(values.name),
    })
    const name = str(values.profile) ?? "default"
    const config = await loadConfig(io)
    const old = config.profiles[name]
    config.profiles[name] = { url, token: res.token }
    config.current = name
    await saveConfig(io, config)
    io.stdout(`Created ${res.team.name}; logged in as @${res.user.name} (profile ${name})\n`)
    await revokeReplaced(io, old, res.token)
  },

  async profiles(argv, io) {
    const { values } = parse(argv, { use: { type: "string" } })
    const config = await loadConfig(io)
    const use = str(values.use)
    if (use) {
      if (!config.profiles[use]) throw new UsageError(`no profile named ${use}`)
      config.current = use
      await saveConfig(io, config)
    }
    for (const [name, p] of Object.entries(config.profiles)) {
      io.stdout(`${name === config.current ? "*" : " "} ${name}  ${p.url}${p.appToken ? "  (+app token)" : ""}\n`)
    }
  },

  async whoami(argv, io) {
    const { values } = parse(argv)
    const s = await session(io, values)
    const who = await s.client.call<{ ok: boolean; user: string; user_id: string; team: string; url: string }>(
      "auth.test",
    )
    if (values.json) return s.print(who)
    io.stdout(`@${who.user} (${who.user_id}) in ${who.team} — ${who.url}\n`)
  },

  async send(argv, io) {
    const { values, positionals } = parse(argv, {
      thread: { type: "string" },
      file: { type: "string", short: "f", multiple: true },
    })
    const [target, ...words] = positionals
    if (!target) throw new UsageError("send needs a recipient: #channel, @person or an id")
    const text = words.length > 0 ? words.join(" ") : await readStdin(io)
    const files = (values.file as string[] | undefined) ?? []
    if (!text && files.length === 0) throw new UsageError("nothing to send: give text, pipe it in, or attach -f <file>")
    const s = await session(io, values)
    const channel = await s.conversation(target)
    const thread = str(values.thread)
    if (files.length > 0) {
      const loaded = await Promise.all(
        files.map(async (path) => ({ name: basename(path), bytes: await io.readFile(path) })),
      )
      const done = await s.client.upload(loaded, { channel, text, threadTs: thread })
      if (values.json) return s.print({ channel, files: done })
      io.stdout(`Sent ${done.length} file${done.length === 1 ? "" : "s"} to ${target}\n`)
      return
    }
    const res = await s.client.call<{ ok: boolean; ts: string; channel: string }>("chat.postMessage", {
      channel,
      text,
      thread_ts: thread,
    })
    if (values.json) return s.print({ channel: res.channel, ts: res.ts })
    io.stdout(`Sent to ${target} (ts ${res.ts})\n`)
  },

  async history(argv, io) {
    const { values, positionals } = parse(argv, { n: { type: "string", short: "n" }, thread: { type: "string" } })
    const [target] = positionals
    if (!target) throw new UsageError("history needs a conversation")
    const s = await session(io, values)
    const channel = await s.conversation(target)
    const limit = Number(str(values.n) ?? "20")
    const thread = str(values.thread)
    const res = thread
      ? await s.client.call<{ ok: boolean; messages: MessageRecord[] }>("conversations.replies", {
          channel,
          ts: thread,
          limit,
        })
      : await s.client.call<{ ok: boolean; messages: MessageRecord[] }>("conversations.history", { channel, limit })
    const messages = thread ? res.messages : res.messages.toReversed()
    if (values.json) return s.print(messages)
    const names = await s.names()
    for (const m of messages) io.stdout(`${messageLine(m, names, thread && m.ts !== thread ? "  ↳ " : "")}\n`)
  },

  async search(argv, io) {
    const { values, positionals } = parse(argv, {
      n: { type: "string", short: "n" },
      page: { type: "string" },
      newest: { type: "boolean" },
    })
    const query = positionals.join(" ")
    if (!query) throw new UsageError("search needs a query")
    const s = await session(io, values)
    const res = await s.client.call<{
      ok: boolean
      messages: {
        total: number
        paging: { page: number; pages: number }
        matches: {
          ts: string
          text: string
          user?: string
          username?: string
          permalink: string
          channel: { id: string; name: string; is_im?: boolean }
        }[]
      }
    }>("search.messages", {
      query,
      count: str(values.n) ?? 20,
      page: str(values.page),
      sort: values.newest ? "timestamp" : "score",
    })
    if (values.json) return s.print(res.messages)
    const names = await s.names()
    for (const m of res.messages.matches) {
      const where = m.channel.is_im ? `@${names.get(m.channel.name) ?? m.channel.name}` : `#${m.channel.name}`
      const who = m.user ? (names.get(m.user) ?? m.username) : m.username
      io.stdout(`${time(m.ts)}  ${where}  ${who}: ${plain(m.text, names).replace(/\n/g, " ")}\n`)
    }
    const { page, pages } = res.messages.paging
    io.stderr(
      `${res.messages.total} match${res.messages.total === 1 ? "" : "es"}${pages > 1 ? ` (page ${page} of ${pages})` : ""}\n`,
    )
  },

  async react(argv, io) {
    const { values, positionals } = parse(argv, { remove: { type: "boolean" } })
    const [target, ts, emoji] = positionals
    if (!target || !ts || !emoji) throw new UsageError("react needs a conversation, a ts and an emoji")
    const s = await session(io, values)
    const channel = await s.conversation(target)
    await s.client.call(values.remove ? "reactions.remove" : "reactions.add", {
      channel,
      timestamp: ts,
      name: emoji.replace(/:/g, ""),
    })
  },

  async edit(argv, io) {
    const { values, positionals } = parse(argv)
    const [target, ts, ...words] = positionals
    if (!target || !ts || words.length === 0) throw new UsageError("edit needs a conversation, a ts and the new text")
    const s = await session(io, values)
    await s.client.call("chat.update", { channel: await s.conversation(target), ts, text: words.join(" ") })
  },

  async delete(argv, io) {
    const { values, positionals } = parse(argv)
    const [target, ts] = positionals
    if (!target || !ts) throw new UsageError("delete needs a conversation and a ts")
    const s = await session(io, values)
    await s.client.call("chat.delete", { channel: await s.conversation(target), ts })
  },

  async channels(argv, io) {
    const { values } = parse(argv, { all: { type: "boolean" } })
    const s = await session(io, values)
    const list = values.all
      ? await s.client.paginate<Conversation & { is_member?: boolean }>("conversations.list", "channels", {
          types: "public_channel,private_channel",
          exclude_archived: true,
        })
      : await s.client.paginate<Conversation>("users.conversations", "channels", {
          types: "public_channel,private_channel,mpim,im",
          exclude_archived: true,
        })
    if (values.json) return s.print(list)
    const names = await s.names()
    const label = (c: Conversation) =>
      c.is_im
        ? `@${names.get(c.user ?? "") ?? c.user}`
        : c.is_mpim
          ? (c.name ?? c.id)
          : `#${c.name}${c.is_private ? " 🔒" : ""}`
    for (const c of list.toSorted((a, b) => label(a).localeCompare(label(b)))) io.stdout(`${c.id}  ${label(c)}\n`)
  },

  async users(argv, io) {
    const { values } = parse(argv)
    const s = await session(io, values)
    const users = (await s.client.paginate<User & { is_bot?: boolean }>("users.list", "members")).filter(
      (u) => !u.deleted,
    )
    if (values.json) return s.print(users)
    for (const u of users) {
      io.stdout(`${u.id}  @${u.name}  ${u.profile?.real_name ?? u.real_name ?? ""}${u.is_bot ? "  [bot]" : ""}\n`)
    }
  },

  async "create-channel"(argv, io) {
    const { values, positionals } = parse(argv, { private: { type: "boolean" } })
    const [name] = positionals
    if (!name) throw new UsageError("create-channel needs a name")
    const s = await session(io, values)
    const res = await s.client.call<{ ok: boolean; channel: { id: string; name: string } }>("conversations.create", {
      name: name.replace(/^#/, ""),
      is_private: Boolean(values.private),
    })
    io.stdout(`Created #${res.channel.name} (${res.channel.id})\n`)
  },

  async join(argv, io) {
    const { values, positionals } = parse(argv)
    const [ref] = positionals
    if (!ref) throw new UsageError("join needs a channel")
    const s = await session(io, values)
    const name = ref.replace(/^#/, "").toLowerCase()
    const all = await s.client.paginate<Conversation>("conversations.list", "channels", { exclude_archived: true })
    const found = all.find((c) => c.name === name || c.id === ref)
    if (!found) throw new UsageError(`no channel #${name}`)
    await s.client.call("conversations.join", { channel: found.id })
    io.stdout(`Joined #${found.name}\n`)
  },

  async leave(argv, io) {
    const { values, positionals } = parse(argv)
    const [ref] = positionals
    if (!ref) throw new UsageError("leave needs a channel")
    const s = await session(io, values)
    await s.client.call("conversations.leave", { channel: await s.conversation(ref) })
  },

  async invite(argv, io) {
    const { values, positionals } = parse(argv)
    const [ref, ...people] = positionals
    if (!ref || people.length === 0) throw new UsageError("invite needs a channel and at least one @person")
    const s = await session(io, values)
    const users = await Promise.all(people.map((p) => resolveUser(s.client, p, s.self)))
    await s.client.call("conversations.invite", { channel: await s.conversation(ref), users: users.join(",") })
  },

  async listen(argv, io) {
    const { values } = parse(argv, { socket: { type: "boolean" } })
    const profile = await activeProfile(io, str(values.profile))
    const socket = Boolean(values.socket) || !profile.token
    const token = socket ? profile.appToken : profile.token
    if (!token) throw new UsageError(socket ? "Socket Mode needs an app token: login --app-token" : "no token")
    const client = createClient({ url: profile.url, token, fetch: io.fetch })
    const names = profile.token ? await (await session(io, values)).names() : new Map<string, string>()
    const listener = listen({
      client,
      mode: socket ? "socket" : "rtm",
      WebSocket: io.WebSocket,
      onStatus: (status, detail) => io.stderr(`[${status}${detail ? `: ${detail}` : ""}]\n`),
      onEvent: (event) => {
        if (values.json) return io.stdout(`${JSON.stringify(event)}\n`)
        if (event.type === "message" && !event.subtype) {
          io.stdout(`${messageLine(event as unknown as MessageRecord, names, `${String(event.channel)}  `)}\n`)
        } else {
          io.stdout(`${event.type}${event.subtype ? `/${String(event.subtype)}` : ""}\n`)
        }
      },
    })
    await io.interrupted()
    listener.close()
  },

  async events(argv, io) {
    const { values } = parse(argv, {
      cursor: { type: "string" },
      wait: { type: "string" },
      follow: { type: "boolean" },
    })
    const s = await session(io, values)
    const names = values.json ? new Map<string, string>() : await s.names()
    const print = (event: RealtimeEvent, cursor: string) => {
      if (values.json) return io.stdout(`${JSON.stringify({ cursor, event })}\n`)
      const line =
        event.type === "message" && !event.subtype
          ? messageLine(event as unknown as MessageRecord, names, `${String(event.channel)}  `)
          : `${event.type}${event.subtype ? `/${String(event.subtype)}` : ""}`
      io.stdout(`${cursor}  ${line}\n`)
    }
    if (values.follow) {
      const follower = follow({
        client: s.client,
        cursor: str(values.cursor),
        waitSeconds: Number(str(values.wait) ?? "30"),
        onEvent: print,
        onGap: () => io.stderr("[gap: events were missed; following from now]\n"),
        onError: (error) => io.stderr(`[error: ${error instanceof ApiError ? error.code : String(error)}; retrying]\n`),
      })
      await io.interrupted()
      follower.close()
      return
    }
    const page = await s.client.call<{
      ok: boolean
      events: { cursor: string; event: RealtimeEvent }[]
      cursor: string
      has_more: boolean
    }>("campflare.events.poll", { cursor: str(values.cursor), wait: str(values.wait) })
    for (const { cursor, event } of page.events) print(event, cursor)
    // The cursor to resume from goes to stderr, so stdout stays one event per line.
    io.stderr(`cursor ${page.cursor}${page.has_more ? " (more)" : ""}\n`)
  },

  async api(argv, io) {
    const { values, positionals } = parse(argv)
    const [method, ...pairs] = positionals
    if (!method) throw new UsageError("api needs a method, e.g. `campflare api conversations.list limit=5`")
    const args: ApiArgs = {}
    for (const pair of pairs) {
      const eq = pair.indexOf("=")
      if (eq <= 0) throw new UsageError(`expected key=value, got ${pair}`)
      args[pair.slice(0, eq)] = pair.slice(eq + 1)
    }
    const profile = await activeProfile(io, str(values.profile))
    const client = createClient({ url: profile.url, token: profile.token, fetch: io.fetch })
    io.stdout(`${JSON.stringify(await client.call(method, args), null, 2)}\n`)
  },

  async admin(argv, io) {
    const [sub, ...rest] = argv
    const { values, positionals } = parse(rest, {
      email: { type: "string" },
      name: { type: "string" },
      admin: { type: "boolean" },
    })
    const s = await session(io, values)
    if (sub === "add-user") {
      const [handle] = positionals
      if (!handle) throw new UsageError("admin add-user needs a handle")
      const res = await s.client.call<{ ok: boolean; user: { id: string; name: string }; token: string }>(
        "campflare.users.create",
        {
          name: handle.replace(/^@/, ""),
          email: str(values.email),
          real_name: str(values.name),
          is_admin: Boolean(values.admin),
        },
      )
      if (values.json) return s.print(res)
      io.stdout(`Added @${res.user.name} (${res.user.id})\nTheir token (shown once): ${res.token}\n`)
    } else if (sub === "add-app") {
      const name = positionals.join(" ")
      if (!name) throw new UsageError("admin add-app needs a name")
      const res = await s.client.call<{
        ok: boolean
        app: { id: string; bot_user_id: string }
        bot_token: string
        app_token: string
      }>("campflare.apps.create", { name })
      if (values.json) return s.print(res)
      io.stdout(
        `Created app ${res.app.id} (bot user ${res.app.bot_user_id})\nBot token: ${res.bot_token}\nApp token: ${res.app_token}\n`,
      )
    } else {
      throw new UsageError("admin commands: add-user, add-app")
    }
  },

  async password(argv, io) {
    const [sub, ...rest] = argv
    const { values } = parse(rest)
    if (sub !== "set") throw new UsageError("password commands: set")
    const s = await session(io, values)
    // Never from argv, where shell history and process lists would keep it.
    let password = (await io.stdin())?.split(/\r?\n/)[0]
    if (password === undefined) {
      if (!io.secret) throw new UsageError("password set reads the password from stdin or a terminal prompt")
      password = await io.secret("New password: ")
      if ((await io.secret("Again: ")) !== password) throw new UsageError("the two passwords differ")
    }
    await s.client.call("campflare.users.setPassword", { password })
    io.stdout("Password set: sign in with your email and it\n")
  },

  async token(argv, io) {
    const [sub, ...rest] = argv
    const { values, positionals } = parse(rest, { label: { type: "string" } })
    const s = await session(io, values)
    if (sub === "create") {
      const res = await s.client.call<{ ok: boolean; token: string }>("campflare.tokens.create", {
        label: str(values.label),
      })
      io.stdout(`${res.token}\n`)
    } else if (sub === "list") {
      const res = await s.client.call<{
        ok: boolean
        tokens: { id: string; kind: string; label: string; created: number }[]
      }>("campflare.tokens.list")
      if (values.json) return s.print(res.tokens)
      for (const t of res.tokens) io.stdout(`${t.id}  ${t.kind}  ${time(String(t.created))}  ${t.label}\n`)
    } else if (sub === "revoke") {
      const [id] = positionals
      if (!id) throw new UsageError("token revoke needs an id from `token list`")
      const res = await s.client.call<{ ok: boolean; revoked: boolean }>("campflare.tokens.revoke", { id })
      io.stdout(res.revoked ? "Revoked\n" : "No such token\n")
    } else {
      throw new UsageError("token commands: create, list, revoke")
    }
  },
}

interface MessageRecord {
  ts: string
  user?: string
  username?: string
  text?: string
  reply_count?: number
  files?: { name?: string }[]
}

/** Runs one command; resolves to the exit code. */
export async function run(argv: string[], io: Io): Promise<number> {
  const [name, ...rest] = argv
  if (!name || name === "help" || name === "--help" || name === "-h") {
    io.stdout(`${HELP}\n`)
    return name ? 0 : 2
  }
  const command = commands[name]
  if (!command) {
    io.stderr(`unknown command: ${name}\n\n${HELP}\n`)
    return 2
  }
  if (rest.includes("--help") || rest.includes("-h")) {
    io.stdout(`${HELP}\n`)
    return 0
  }
  try {
    return (await command(rest, io)) ?? 0
  } catch (error) {
    if (error instanceof UsageError) {
      io.stderr(`${error.message}\n`)
      return 2
    }
    if (error instanceof ApiError) {
      io.stderr(
        `error: ${error.code}${error.data.response_metadata?.messages ? ` ${error.data.response_metadata.messages.join(" ")}` : ""}\n`,
      )
      return 1
    }
    io.stderr(`error: ${error instanceof Error ? error.message : String(error)}\n`)
    return 1
  }
}
