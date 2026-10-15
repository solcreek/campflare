import {
  ApiError,
  createClient,
  follow,
  listen,
  serverRoot,
  type ApiArgs,
  type Client,
  type RealtimeEvent,
} from "@campflare/client"
import { basename } from "node:path"
import { parseArgs, type ParseArgsConfig } from "node:util"
import { activeProfile, loadConfig, saveConfig, type Profile } from "./config"
import { deliveryLines, messageLine, plain, time, type EventDelivery } from "./format"
import { UsageError, type Io } from "./io"
import { oauthLogin, revokeToken, tokenOwner } from "./oauth"
import { resolveConversation, resolveUser, type Conversation, type User } from "./resolve"

const HELP = `campflare — the command line for Campflare (and any Slack-compatible API)

Usage: campflare <command> [options]

Account
  login --url <server> --token <xoxp-…> [--app-token <xapp-…>] [--profile <name>]
  login --url <server> --oauth [--port N]   sign in through the browser instead
                                 a login over a profile from --oauth revokes its old token only
                                 when it's a re-login (same server and user); else it's kept
  logout [--profile <name>]      forget the profile; revokes a token from login --oauth
  bootstrap --url <server> --secret <s> --team <name> --user <handle> [--email <e>]
  whoami                         who the token belongs to, their role and the token's scopes
  profiles                       list saved profiles; --use <name> switches
  password set                   set your password for signing in with your email (asks, or reads stdin)

Messages
  send <#channel|@person|id> [text] [--thread <ts>] [-f <file>]…   text from stdin if piped
  history <#channel|@person|id> [-n 20] [--thread <ts>] [--json]
  search <query> [-n 20] [--page N] [--newest] [--json]
  react <#channel|id> <ts> <emoji> [--remove]
  edit <#channel|id> <ts> <text>      delete <#channel|id> <ts>
  click <#channel|id> <ts> [action_id] [--block <id>] [--value <v>]
        [--option <value>] [--user <@person>] [--conversation <#channel>]
                                   click a button, or choose in a select menu, in an app's
                                   message (Campflare); without an action_id, lists what's
                                   clickable and how; an ephemeral message's needs its action_id
  view list [--json]               the modals apps opened for you, their inputs and buttons
  view submit <view id> [--value block_id.action_id=value]…
                                   fill in and submit the top one (repeat --value for
                                   checkboxes and multi-selects; @names and #names resolve)
  view close <view id>             close it (and those opened on it)
  view click <view id> <action_id> [--block <id>] [--value|--option|--user|--conversation …]
  stop <#channel|id> <ts>          stop an app's reply that is still streaming (Campflare);
                                   the app's next append is answered stopped_by_user

Apps (with a bot token: CAMPFLARE_TOKEN=xoxb-…)
  stream <#channel|@person|id> [--thread <ts>] [--to @person] [--status <text>] [--blocks <json>]
                                 stream piped markdown into one message as it arrives
                                 (chat.startStream, appendStream per piece, stopStream at the end);
                                 when a person stops it, says so and reads no more
  status <#channel|id> <thread ts> [text]   the app's status in a thread; no text clears it

Workspace
  channels [--all] [--json]        users [--json]
  create-channel <name> [--private]   join <#channel>   leave <#channel>
  invite <#channel> <@person>…
  listen [--json] [--socket]       stream live events (RTM, or Socket Mode with an app token)
  events [--cursor N] [--wait S] [--follow] [--json]
                                   the event log (Campflare): what came since a cursor, by polling
  api <method> [key=value]…        call any Web API method, print the JSON
  api --list [prefix]              every method, the tokens it takes and the scopes it needs

Admin (Campflare only)
  admin add-user <handle> [--email <e>] [--name <real name>] [--admin]
  admin add-app <name>             a bot token, a Socket Mode app token and a signing secret
  admin app <app id> [--request-url <url>] [--events <a,b>] [--interactivity-url <url>]
            [--rotate-secret]      an app's settings; set where its events are POSTed
                                   (checked with url_verification; '' stops) and which,
                                   and where clicks on its buttons are POSTed ('' stops);
                                   --rotate-secret replaces the signing secret at once.
                                   Shows how deliveries are doing, and if they were
                                   turned off for failing (set the URL again to resume)
  admin role <@person> member|admin|owner   (owners only)
  token create [--preset read|write|full] [--scopes a,b] [--expires 1h|7d|<seconds>] [--label <l>]
                                   a token for a script or an agent: the preset and scopes
                                   together, never more than this token holds; prints the
                                   token alone on stdout (--json: with its scopes and expiry)
  token list                       token revoke <id>

Global: --profile <name>, --json. Exit codes: 0 ok, 1 API error, 2 usage.`

type Values = Record<string, string | boolean | (string | boolean)[] | undefined>

type AppSettings = {
  ok: boolean
  app: {
    id: string
    name: string
    bot_user_id: string
    signing_secret: string
    event_subscriptions: { request_url: string | null; events: string[] | null } & EventDelivery
    interactivity: { request_url: string | null }
  }
}

/**
 * What a click can be on: a button (an icon button too), one of a
 * feedback_buttons pair, or a select menu, which takes an option (`options`)
 * or a person or conversation (`takes`).
 */
interface Clickable {
  block_id: string
  action_id: string
  type: string
  label: string
  value?: string
  options?: string[]
  takes?: "user" | "conversation"
}

type ElementJson = Record<string, unknown>
type BlockJson = { type?: string; block_id?: string; elements?: ElementJson[]; accessory?: ElementJson }

const labelOf = (text: unknown) =>
  text && typeof text === "object" && "text" in text ? String((text as { text: unknown }).text) : ""

/** A select's or an element's options, those in groups included, by value. */
function optionValues(e: ElementJson): string[] {
  const groups = Array.isArray(e.option_groups) ? (e.option_groups as { options?: unknown }[]) : []
  const options = [e.options, ...groups.map((g) => g.options)].flatMap((o) => (Array.isArray(o) ? o : []))
  return options.map((o) => String((o as { value?: unknown }).value ?? ""))
}

const TAKES: Record<string, "user" | "conversation"> = {
  users_select: "user",
  conversations_select: "conversation",
  channels_select: "conversation",
}

/** The clickable elements of blocks (actions and context_actions blocks, sections' accessories), as `click` takes them. */
export function clickables(blocks: unknown): Clickable[] {
  if (!Array.isArray(blocks)) return []
  const found: Clickable[] = []
  for (const block of blocks as BlockJson[]) {
    const elements =
      block?.type === "actions" || block?.type === "context_actions"
        ? (block.elements ?? [])
        : block?.type === "section" && block.accessory
          ? [block.accessory]
          : []
    for (const e of elements) {
      const type = String(e.type)
      const ids = { block_id: String(block.block_id ?? ""), action_id: String(e.action_id ?? ""), type }
      if (type === "button" || type === "icon_button") {
        found.push({ ...ids, label: labelOf(e.text), ...(typeof e.value === "string" ? { value: e.value } : {}) })
      } else if (type === "feedback_buttons") {
        for (const key of ["positive_button", "negative_button"] as const) {
          const b = e[key] as { text?: unknown; value?: string } | undefined
          if (b) found.push({ ...ids, label: labelOf(b.text), value: String(b.value ?? "") })
        }
      } else if (type === "static_select" || type === "overflow") {
        found.push({ ...ids, label: labelOf(e.placeholder), options: optionValues(e) })
      } else if (TAKES[type]) {
        found.push({ ...ids, label: labelOf(e.placeholder), takes: TAKES[type] })
      }
    }
  }
  return found
}

/** How to click one, as `click` (or `view click`) takes it. */
function clickLine(c: Clickable): string {
  const how =
    c.options !== undefined
      ? `  --option ${c.options.join("|")}`
      : c.takes === "user"
        ? "  --user <@person>"
        : c.takes === "conversation"
          ? "  --conversation <#channel>"
          : c.value !== undefined
            ? `  --value ${c.value}`
            : ""
  const menu = c.type.endsWith("select") || c.type === "overflow" ? `(${c.type})` : ""
  return `${c.action_id}  ${[c.label, menu].filter(Boolean).join(" ")}${how}  --block ${c.block_id}\n`
}

const CLICK_OPTIONS: ParseArgsConfig["options"] = {
  block: { type: "string" },
  value: { type: "string" },
  option: { type: "string" },
  user: { type: "string" },
  conversation: { type: "string" },
}

const via = (delivered: string | undefined) => (delivered === "socket" ? "Socket Mode" : "HTTP")

/** An open view (modal), as campflare.views.list gives it. */
interface ViewJson {
  id: string
  title?: unknown
  callback_id?: string
  app_id?: string
  submit?: unknown
  blocks?: BlockJson[]
}

/** Inputs whose value is a person, or a conversation: `view submit` resolves @names and #names for them. */
const INPUT_TAKES: Record<string, "user" | "conversation"> = {
  ...TAKES,
  multi_users_select: "user",
  multi_conversations_select: "conversation",
  multi_channels_select: "conversation",
}

type InputBlock = BlockJson & { label?: unknown; optional?: boolean; element?: ElementJson }

/** A view for people and agents: its title, its inputs and how to fill each, its buttons, how to submit. */
function describeView(view: ViewJson, top: boolean): string {
  const lines = [
    `${view.id}  ${labelOf(view.title)}  (${view.callback_id || "no callback_id"})${top ? "  [shown]" : ""}`,
  ]
  for (const block of (view.blocks ?? []) as InputBlock[]) {
    if (block.type !== "input" || !block.element) continue
    const e = block.element
    const type = String(e.type)
    const options = optionValues(e)
    const takes = INPUT_TAKES[type]
    const hint =
      options.length > 0
        ? `  one of ${options.join("|")}`
        : takes
          ? `  a ${takes === "user" ? "@person" : "#channel"}`
          : ""
    lines.push(
      `  --value ${block.block_id}.${String(e.action_id)}=…  ${labelOf(block.label)} (${type}${block.optional ? ", optional" : ""})${hint}`,
    )
  }
  for (const c of clickables(view.blocks)) lines.push(`  view click ${view.id} ${clickLine(c).trimEnd()}`)
  if (top && view.submit) lines.push(`  submit: campflare view submit ${view.id} --value block.action=value …`)
  return `${lines.join("\n")}\n`
}

/**
 * `--value block.action=value` pairs as campflare.views.submit takes them:
 * repeated for checkboxes and multi-selects; @names and #names resolved for
 * inputs that take a person or a conversation.
 */
async function formValues(s: Session, view: ViewJson, pairs: string[]) {
  const elements = new Map<string, string>()
  for (const block of (view.blocks ?? []) as InputBlock[]) {
    if (block.type === "input" && block.element) {
      elements.set(`${block.block_id}.${String(block.element.action_id)}`, String(block.element.type))
    }
  }
  const given: Record<string, Record<string, string | string[]>> = {}
  for (const pair of pairs) {
    const eq = pair.indexOf("=")
    const key = eq > 0 ? pair.slice(0, eq) : ""
    const dot = key.indexOf(".")
    if (dot <= 0) throw new UsageError(`expected --value block_id.action_id=value, got ${pair}`)
    const [blockId, actionId] = [key.slice(0, dot), key.slice(dot + 1)]
    let value = pair.slice(eq + 1)
    const takes = INPUT_TAKES[elements.get(key) ?? ""]
    if (takes === "user" && value) value = await resolveUser(s.client, value, s.self)
    if (takes === "conversation" && value) value = await s.conversation(value)
    const inputs = (given[blockId] ??= {})
    const before = inputs[actionId]
    inputs[actionId] = before === undefined ? value : [before, value].flat()
  }
  return given
}

/** What a click chooses: --value or --option as given, --user and --conversation resolved to ids. */
async function clickValue(s: Session, values: Values): Promise<string | undefined> {
  const user = str(values.user)
  if (user) return resolveUser(s.client, user, s.self)
  const conversation = str(values.conversation)
  if (conversation) return s.conversation(conversation)
  return str(values.option) ?? str(values.value)
}

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

/** A server however it was typed: "https://X.test/api/" is "https://x.test/". */
function serverKey(url: string): string {
  try {
    return new URL(serverRoot(url)).href
  } catch {
    return url
  }
}

const sameServer = (a: string, b: string) => serverKey(a) === serverKey(b)

/**
 * A login wrote over `old`, now signed in at `url` as `who`. The old token, if it came from
 * `login --oauth`, is revoked when this was a re-login: the same server and the same person in
 * the same workspace, so nothing would know the old one any more. Signed in anywhere else, it
 * is kept (another machine or a script may use it) and the person is told how to end it.
 * Best effort: a server that doesn't answer is a reason on stderr, never a failed login.
 */
async function replaceProfile(io: Io, old: Profile | undefined, url: string, token: string, who: AuthTest) {
  if (old?.via !== "oauth" || !old.token || old.token === token) return
  const owner = sameServer(old.url, url) ? await tokenOwner(io, old.url, old.token) : undefined
  if (owner === "rejected") return // already ended there
  if (owner && "user_id" in owner && owner.user_id === who.user_id && owner.team_id === who.team_id) {
    const res = await revokeToken(io, old.url, old.token)
    if (!res.revoked) {
      io.stderr(`Couldn't revoke the previous token at ${old.url} (${res.reason}); it works until revoked there\n`)
    }
    return
  }
  const whose = owner && "user_id" in owner ? ` for @${owner.user} in ${owner.team}` : ""
  const why = !owner
    ? "this login is to another server"
    : "user_id" in owner
      ? "this login is another user or workspace"
      : `couldn't ask whose it is: ${owner.unknown}`
  io.stderr(
    `Didn't revoke the previous token of this profile (from login --oauth at ${old.url}${whose}; ${why}): ` +
      "it still works. To end it, log in there and run `campflare token list`, then `campflare token revoke <id>`\n",
  )
}

type AuthTest = { ok: boolean; user: string; team: string; user_id: string; team_id: string }

/** Markdown per chat.appendStream, as Slack limits it. */
const MAX_STREAM_PIECE = 12_000

/** Text in pieces of at most `max` characters, never splitting one. */
function split(text: string, max: number): string[] {
  const chars = Array.from(text)
  const out: string[] = []
  for (let i = 0; i < chars.length; i += max) out.push(chars.slice(i, i + max).join(""))
  return out
}

/** The workspace of a bot token; anything else is a usage mistake, said plainly before the server refuses. */
async function botTeam(s: Session, command: string): Promise<string> {
  const who = await s.client.call<{ ok: boolean; team_id: string; bot_id?: string }>("auth.test")
  if (!who.bot_id) {
    throw new UsageError(
      `${command} acts as an app: use its bot token, CAMPFLARE_TOKEN=xoxb-… (pnpm dev:all writes CAMPFLARE_BOT_TOKEN)`,
    )
  }
  return who.team_id
}

/**
 * Outside a DM a stream answers someone: --to, else whoever started the thread.
 */
async function streamRecipient(s: Session, channel: string, thread: string | undefined, to: string | undefined) {
  if (to) return resolveUser(s.client, to, s.self)
  if (!thread) throw new UsageError("stream outside a DM answers someone: give --to @person or --thread <ts>")
  const res = await s.client.call<{ ok: boolean; messages: { user?: string }[] }>("conversations.replies", {
    channel,
    ts: thread,
    limit: 1,
  })
  const user = res.messages[0]?.user
  if (!user) throw new UsageError("the thread's first message has no author to answer: give --to @person")
  return user
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
    const who = await client.call<AuthTest>("auth.test")
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
    await replaceProfile(io, old, url, token, who)
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
      team: { id: string; name: string }
      user: { id: string; name: string }
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
    const who = { ok: true, user: res.user.name, team: res.team.name, user_id: res.user.id, team_id: res.team.id }
    await replaceProfile(io, old, url, res.token, who)
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
    const [who, scopes] = await Promise.all([
      s.client.call<{ ok: boolean; user: string; user_id: string; team: string; url: string; bot_id?: string }>(
        "auth.test",
      ),
      s.client.scopes(),
    ])
    const role = await roleOf(s.client, who.user_id, scopes)
    if (values.json) return s.print({ ...who, role, scopes })
    io.stdout(`@${who.user} (${who.user_id}) in ${who.team} — ${who.url}\n`)
    io.stdout(`${role ? `Role: ${role}. ` : ""}Scopes: ${scopes.join(", ") || "none"}\n`)
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

  async stream(argv, io) {
    const { values, positionals } = parse(argv, {
      thread: { type: "string" },
      to: { type: "string" },
      status: { type: "string" },
      blocks: { type: "string" },
    })
    const [target] = positionals
    if (!target) throw new UsageError("stream needs a conversation: #channel, @person or an id")
    const thread = str(values.thread)
    if (values.status !== undefined && !thread) throw new UsageError("--status needs --thread: it shows in a thread")
    let blocks: object | undefined
    if (values.blocks !== undefined) {
      try {
        blocks = JSON.parse(str(values.blocks)!) as object
      } catch {
        throw new UsageError("--blocks wants a JSON array of blocks")
      }
    }
    const pieces = io.stdinChunks?.() ?? (await readStdin(io).then((text) => (text ? [text] : undefined)))
    if (!pieces) throw new UsageError("stream reads markdown from stdin: pipe it in")
    const s = await session(io, values)
    const team = await botTeam(s, "stream")
    const channel = await s.conversation(target)
    const recipient = channel.startsWith("D") ? undefined : await streamRecipient(s, channel, thread, str(values.to))
    if (values.status !== undefined) {
      await s.client.call("assistant.threads.setStatus", {
        channel_id: channel,
        thread_ts: thread,
        status: values.status,
      })
    }
    const { ts } = await s.client.call<{ ok: boolean; ts: string }>("chat.startStream", {
      channel,
      thread_ts: thread,
      ...(recipient ? { recipient_user_id: recipient, recipient_team_id: team } : {}),
    })
    io.stderr(`Streaming to ${target} (ts ${ts})\n`)
    let sent = 0
    for await (const piece of pieces) {
      for (const markdown_text of split(piece, MAX_STREAM_PIECE)) {
        try {
          await s.client.call("chat.appendStream", { channel, ts, markdown_text })
        } catch (error) {
          if (!(error instanceof ApiError && error.code === "stopped_by_user")) throw error
          // Someone in the conversation stopped it: the message stays as it was.
          if (values.json) return s.print({ channel, ts, stopped_by_user: true })
          io.stdout(`Stopped by someone in ${target} after ${sent} characters (ts ${ts})\n`)
          return
        }
        sent += markdown_text.length
      }
    }
    const stopped = await s.client.call<{ ok: boolean; message: { text: string } }>("chat.stopStream", {
      channel,
      ts,
      blocks,
    })
    if (values.json) return s.print({ channel, ts, message: stopped.message })
    io.stdout(`Streamed ${stopped.message.text.length} characters to ${target} (ts ${ts})\n`)
  },

  async status(argv, io) {
    const { values, positionals } = parse(argv)
    const [target, ts, ...words] = positionals
    if (!target || !ts) throw new UsageError("status needs a conversation and a thread ts")
    const s = await session(io, values)
    await botTeam(s, "status")
    const channel = await s.conversation(target)
    const status = words.join(" ")
    await s.client.call("assistant.threads.setStatus", { channel_id: channel, thread_ts: ts, status })
    io.stdout(status ? `Status set in ${target}: ${status}\n` : `Status cleared in ${target}\n`)
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

  async click(argv, io) {
    const { values, positionals } = parse(argv, CLICK_OPTIONS)
    const [target, ts, actionId] = positionals
    if (!target || !ts) throw new UsageError("click needs a conversation and a message ts (and an action_id)")
    const s = await session(io, values)
    const channel = await s.conversation(target)
    if (!actionId) {
      const res = await s.client.call<{ ok: boolean; messages: { ts: string; blocks?: unknown }[] }>(
        "conversations.history",
        { channel, latest: ts, inclusive: true, limit: 1 },
      )
      const message = res.messages.find((m) => m.ts === ts)
      if (!message) throw new UsageError(`no message ${ts} in ${target} (a reply? give its action_id)`)
      const found = clickables(message.blocks)
      if (values.json) return s.print(found)
      if (found.length === 0) io.stdout("No buttons in that message\n")
      for (const c of found) io.stdout(clickLine(c))
      return
    }
    const res = await s.client.call<{ ok: boolean; delivered: string }>("campflare.blocks.action", {
      channel,
      ts,
      action_id: actionId,
      block_id: str(values.block),
      value: await clickValue(s, values),
    })
    if (values.json) return s.print(res)
    io.stdout(`Clicked: the app took it (${via(res.delivered)}); if it opened a view: campflare view list\n`)
  },

  async view(argv, io) {
    const [sub, ...rest] = argv
    if (!sub || !["list", "submit", "close", "click"].includes(sub)) {
      throw new UsageError("view takes list, submit, close or click")
    }
    const { values, positionals } = parse(rest, { ...CLICK_OPTIONS, value: { type: "string", multiple: true } })
    const s = await session(io, values)
    const list = async () => (await s.client.call<{ ok: boolean; views: ViewJson[] }>("campflare.views.list")).views
    if (sub === "list") {
      const views = await list()
      if (values.json) return s.print(views)
      if (views.length === 0) io.stdout("No views open\n")
      views.forEach((v, i) => io.stdout(describeView(v, i === views.length - 1)))
      return
    }
    const [viewId, actionId] = positionals
    if (!viewId) throw new UsageError(`view ${sub ?? ""} needs a view id (campflare view list shows them)`.trim())
    if (sub === "submit") {
      const view = (await list()).find((v) => v.id === viewId)
      if (!view) throw new UsageError(`no open view ${viewId} (campflare view list shows them)`)
      const given = await formValues(s, view, [values.value ?? []].flat().map(String))
      const res = await s.client.call<{
        ok: boolean
        views: ViewJson[]
        errors?: Record<string, string>
        delivered?: string
      }>("campflare.views.submit", { view_id: viewId, values: JSON.stringify(given) })
      if (values.json) {
        s.print(res)
        return res.errors ? 1 : 0
      }
      if (res.errors) {
        for (const [block, message] of Object.entries(res.errors)) io.stderr(`${block}: ${message}\n`)
        return 1
      }
      const top = res.views.at(-1)
      io.stdout(
        `Submitted: the app took it (${via(res.delivered)})${top ? `; now showing ${top.id} ${labelOf(top.title)}` : ""}\n`,
      )
      return
    }
    if (sub === "close") {
      const res = await s.client.call<{ ok: boolean; views: ViewJson[] }>("campflare.views.close", { view_id: viewId })
      if (values.json) return s.print(res)
      const top = res.views.at(-1)
      io.stdout(`Closed${top ? `; now showing ${top.id} ${labelOf(top.title)}` : ""}\n`)
      return
    }
    // click
    if (!actionId) throw new UsageError("view click needs a view id and an action_id")
    const res = await s.client.call<{ ok: boolean; delivered: string }>("campflare.blocks.action", {
      view_id: viewId,
      action_id: actionId,
      block_id: str(values.block),
      value: await clickValue(s, { ...values, value: [values.value ?? []].flat()[0] as string | undefined }),
    })
    if (values.json) return s.print(res)
    io.stdout(`Clicked: the app took it (${via(res.delivered)})\n`)
  },

  async stop(argv, io) {
    const { values, positionals } = parse(argv)
    const [target, ts] = positionals
    if (!target || !ts) throw new UsageError("stop needs a conversation and the streaming message's ts")
    const s = await session(io, values)
    const channel = await s.conversation(target)
    const res = await s.client.call<{ ok: boolean; message: { text: string } }>("campflare.chat.stopStream", {
      channel,
      ts,
    })
    if (values.json) return s.print(res.message)
    io.stdout(`Stopped the reply in ${target} (ts ${ts}) at ${res.message.text.length} characters\n`)
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
    const { values, positionals } = parse(argv, { list: { type: "boolean" }, url: { type: "string" } })
    if (values.list) return listMethods(io, values, positionals[0])
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
      "request-url": { type: "string" },
      events: { type: "string" },
      "interactivity-url": { type: "string" },
      "rotate-secret": { type: "boolean" },
    })
    const s = await session(io, values)
    if (sub === "role") {
      const [who, role] = positionals
      if (!who || !role) throw new UsageError("admin role needs a person and a role: member, admin or owner")
      const user = await resolveUser(s.client, who, s.self)
      const res = await s.client.call<{ ok: boolean; user: { name: string } }>("campflare.users.setRole", {
        user,
        role,
      })
      if (values.json) return s.print(res)
      io.stdout(`@${res.user.name} is now ${role === "member" ? "a member" : `an ${role}`}\n`)
    } else if (sub === "add-user") {
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
        signing_secret: string
      }>("campflare.apps.create", { name })
      if (values.json) return s.print(res)
      io.stdout(
        `Created app ${res.app.id} (bot user ${res.app.bot_user_id})\nBot token: ${res.bot_token}\nApp token: ${res.app_token}\n` +
          `Signing secret: ${res.signing_secret}\n` +
          `Events come over Socket Mode (the app token), or over HTTP: campflare admin app ${res.app.id} --request-url <url>\n`,
      )
    } else if (sub === "app") {
      const [app] = positionals
      if (!app) throw new UsageError("admin app needs an app id (from admin add-app)")
      const url = str(values["request-url"])
      const events = str(values.events)
      const interactivity = str(values["interactivity-url"])
      let res: AppSettings | undefined
      // First, so a Request URL set in the same command is verified with the new secret.
      if (values["rotate-secret"]) res = await s.client.call<AppSettings>("campflare.apps.rotateSigningSecret", { app })
      if (url !== undefined || events !== undefined) {
        res = await s.client.call<AppSettings>("campflare.apps.setEventSubscriptions", {
          app,
          ...(url === undefined ? {} : { request_url: url }),
          ...(events === undefined ? {} : { events }),
        })
      }
      if (interactivity !== undefined) {
        res = await s.client.call<AppSettings>("campflare.apps.setInteractivity", { app, request_url: interactivity })
      }
      res ??= await s.client.call<AppSettings>("campflare.apps.info", { app })
      if (values.json) return s.print(res)
      const { id, name, bot_user_id, signing_secret, event_subscriptions: subs } = res.app
      io.stdout(
        `App ${id} (${name}), bot user ${bot_user_id}\nSigning secret: ${signing_secret}\n` +
          `Request URL: ${subs.request_url ?? "none (Socket Mode only)"}\nEvents: ${subs.events?.join(", ") ?? "all"}\n` +
          `Interactivity URL: ${res.app.interactivity.request_url ?? "none (Socket Mode only)"}\n`,
      )
      for (const line of deliveryLines(subs)) io.stdout(`${line}\n`)
      if (values["rotate-secret"]) {
        io.stdout("The old signing secret no longer signs anything: update the app's secret now.\n")
      }
    } else {
      throw new UsageError("admin commands: add-user, add-app, app")
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
    const { values, positionals } = parse(rest, {
      label: { type: "string" },
      preset: { type: "string" },
      scopes: { type: "string" },
      expires: { type: "string" },
    })
    const s = await session(io, values)
    if (sub === "create") {
      const expires = str(values.expires)
      const res = await s.client.call<{ ok: boolean; token: string; scopes: string[]; expires: number | null }>(
        "campflare.tokens.create",
        {
          label: str(values.label),
          preset: str(values.preset),
          scopes: str(values.scopes),
          expires_in: expires === undefined ? undefined : seconds(expires),
        },
      )
      if (values.json) return s.print({ token: res.token, scopes: res.scopes, expires: res.expires })
      // The token alone on stdout, for TOKEN=$(campflare token create …); what it holds on stderr.
      io.stdout(`${res.token}\n`)
      io.stderr(`Scopes: ${res.scopes.join(", ")}${res.expires ? `; expires ${isoTime(res.expires)}` : ""}\n`)
    } else if (sub === "list") {
      const res = await s.client.call<{
        ok: boolean
        tokens: {
          id: string
          kind: string
          label: string
          created: number
          scopes?: string[]
          expires?: number | null
        }[]
      }>("campflare.tokens.list")
      if (values.json) return s.print(res.tokens)
      for (const t of res.tokens) {
        const expiry = t.expires ? `  expires ${isoTime(t.expires)}` : ""
        io.stdout(
          `${t.id}  ${t.kind}  ${time(String(t.created))}  ${t.label}  [${(t.scopes ?? []).join(",")}]${expiry}\n`,
        )
      }
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

const UNITS: Record<string, number> = { s: 1, m: 60, h: 3600, d: 86_400, w: 604_800 }

/** "90", "30m", "12h", "7d", "2w" as seconds. */
export function seconds(text: string): number {
  const match = /^(\d+)([smhdw]?)$/.exec(text.trim())
  if (!match) throw new UsageError(`--expires takes seconds or a number with s, m, h, d or w: got ${text}`)
  return Number(match[1]) * UNITS[match[2] || "s"]!
}

const isoTime = (epoch: number) => new Date(epoch * 1000).toISOString().replace(/\.\d+Z$/, "Z")

/** A person's role from users.info, when the token may read it (users:read); bots have none. */
async function roleOf(client: Client, userId: string, scopes: string[]): Promise<string | undefined> {
  if (!scopes.includes("users:read")) return undefined
  const { user } = await client.call<{ ok: boolean; user: { is_bot: boolean; is_admin: boolean; is_owner: boolean } }>(
    "users.info",
    { user: userId },
  )
  if (user.is_bot) return "bot"
  return user.is_owner ? "owner" : user.is_admin ? "admin" : "member"
}

/** campflare.methods.list as a table: one method a line, its token types and scopes. */
async function listMethods(io: Io, values: Values, prefix = "") {
  const profile = await activeProfile(io, str(values.profile)).catch(() => undefined)
  const url = str(values.url) ?? profile?.url ?? io.env.CAMPFLARE_URL
  if (!url) throw new UsageError("api --list needs a server: log in, or pass --url")
  const res = await createClient({ url, fetch: io.fetch }).call<{
    ok: boolean
    methods: { name: string; tokens: string[]; scopes: string[]; conversation_scope?: string }[]
    presets: Record<string, string[]>
  }>("campflare.methods.list")
  const methods = res.methods.filter((m) => m.name.startsWith(prefix))
  if (values.json) {
    io.stdout(`${JSON.stringify({ methods, presets: res.presets }, null, 2)}\n`)
    return
  }
  for (const m of methods) {
    const scopes = m.conversation_scope ? `*:${m.conversation_scope} for the conversation's type` : m.scopes.join(" | ")
    io.stdout(`${m.name}  (${m.tokens.join(", ") || "no token"})  ${scopes || "no scope"}\n`)
  }
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
      // An agent reading --json output gets the error as JSON too, on stderr.
      if (rest.includes("--json")) {
        io.stderr(`${JSON.stringify(error.data)}\n`)
        return 1
      }
      io.stderr(`error: ${error.code}${errorDetail(error)}\n`)
      return 1
    }
    io.stderr(`error: ${error instanceof Error ? error.message : String(error)}\n`)
    return 1
  }
}

/** What an API error adds to its code: Slack's messages, or which scopes would do. */
function errorDetail(error: ApiError): string {
  const data = error.data as ApiError["data"] & { needed?: string; provided?: string }
  if (error.code === "missing_scope" && data.needed) {
    return (
      ` (needs ${data.needed.split(",").join(" or ")}; this token has ${data.provided || "none"}). ` +
      "A token with it: campflare token create --scopes <scope>"
    )
  }
  const messages = data.response_metadata?.messages
  return messages ? ` ${messages.join(" ")}` : ""
}
