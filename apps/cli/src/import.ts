import type { Client } from "@campflare/client"
import { basename } from "node:path"
import { UsageError, type Io } from "./io"
import { parse, session, str, type Session } from "./run"
import { memoryAccess, openZip, type Zip, type ZipEntry } from "./zip"

// campflare import: reads a Slack export zip here and sends it to
// campflare.import.* in chunks (docs/import.md). Re-running continues.

/** Messages per campflare.import.messages call, and their JSON at most (the server takes 1000 and 4 MB). */
const CHUNK_MESSAGES = 500
const CHUNK_BYTES = 1_000_000
const USERS_PER_CALL = 500
const CONVERSATIONS_PER_CALL = 200

type Json = Record<string, unknown>

interface ExportFile {
  id?: string
  name?: string
  title?: string
  mode?: string
  url_private_download?: string
  url_private?: string
  /** A link to a file elsewhere (Google Drive, Dropbox…), not Slack's to serve. */
  is_external?: boolean
}

interface ExportMessage extends Json {
  ts: string
  text?: string
  files?: ExportFile[]
  reactions?: { name?: string; users?: string[] }[]
}

interface ExportUser {
  id: string
  name?: string
  is_bot?: boolean
  deleted?: boolean
  profile?: { email?: string }
}

interface ExportConversation extends Json {
  id: string
  name?: string
  members?: string[]
  type: "channel" | "group" | "mpim" | "im"
}

const COUNTS = [
  "users_mapped",
  "users_created",
  "conversations_created",
  "conversations_renamed",
  "conversations_merged",
  "conversations_skipped",
  "messages",
  "messages_skipped",
  "reactions",
  "pins",
  "files",
  "files_attached",
  "files_skipped",
] as const

export interface JobJson {
  id: string
  state: string
  options: { merge_into_existing: boolean; files: string; source_name?: string }
  counts: Record<(typeof COUNTS)[number], number> & { unmapped_users: string[] }
  created: number
  finished: number | null
}

/** An export opened: its people, its conversations, and each conversation's day files in order. */
interface Export {
  zip: Zip
  users: ExportUser[]
  conversations: ExportConversation[]
  days: Map<string, ZipEntry[]>
  json<T>(entry: ZipEntry): Promise<T>
}

const DAY = /^(\d{4}-\d{2}-\d{2})\.json$/

async function readExport(zip: Zip): Promise<Export> {
  // Some tools zip the export's folder rather than its contents: allow one folder around it all.
  const usersEntry = zip.entries.find((e) => /^(?:[^/]+\/)?users\.json$/.test(e.name))
  if (!usersEntry) throw new UsageError("not a Slack export: no users.json in the zip")
  const prefix = usersEntry.name.slice(0, -"users.json".length)
  const byName = new Map(zip.entries.map((e) => [e.name, e]))
  const decoder = new TextDecoder()
  const json = async <T>(entry: ZipEntry) => JSON.parse(decoder.decode(await zip.read(entry))) as T
  const list = async <T>(name: string) => {
    const entry = byName.get(prefix + name)
    return entry ? json<T[]>(entry) : []
  }
  const users = await list<ExportUser>("users.json")
  const conversations: ExportConversation[] = []
  for (const [file, type] of [
    ["channels.json", "channel"],
    ["groups.json", "group"],
    ["mpims.json", "mpim"],
    ["dms.json", "im"],
  ] as const) {
    for (const c of await list<Json & { id: string }>(file)) conversations.push({ ...c, type })
  }
  const days = new Map<string, ZipEntry[]>()
  for (const e of zip.entries) {
    if (!e.name.startsWith(prefix)) continue
    const [folder, day, ...more] = e.name.slice(prefix.length).split("/")
    if (!folder || !day || more.length || !DAY.test(day)) continue
    days.set(folder, [...(days.get(folder) ?? []), e])
  }
  for (const entries of days.values()) entries.sort((a, b) => a.name.localeCompare(b.name))
  return { zip, users, conversations, days, json }
}

/** A conversation's folder: a DM's is its id; the rest are named. */
const folderOf = (c: ExportConversation) => (c.type === "im" ? c.id : (c.name ?? c.id))
const dayOf = (entry: ZipEntry) => entry.name.split("/").at(-1)!

/** What the server reads of a conversation. */
function conversationArgs(c: ExportConversation): Json {
  const out: Json = {}
  for (const k of [
    "id",
    "type",
    "name",
    "created",
    "creator",
    "is_archived",
    "is_general",
    "members",
    "topic",
    "purpose",
  ]) {
    if (c[k] !== undefined) out[k] = c[k]
  }
  return out
}

/** What the server reads of a message: the rest of an export's (user profiles, block details) stays here. */
function trim(m: ExportMessage): Json {
  const keep = [
    "ts",
    "user",
    "username",
    "subtype",
    "text",
    "thread_ts",
    "parent_user_id",
    "edited",
    "pinned_to",
    "pinned_info",
    "attachments",
  ]
  const out: Json = {}
  for (const k of keep) if (m[k] !== undefined) out[k] = m[k]
  const bot = m.bot_profile as { name?: string } | undefined
  if (bot?.name) out.bot_profile = { name: bot.name }
  const profile = m.user_profile as { real_name?: string; name?: string } | undefined
  if (profile) out.user_profile = { real_name: profile.real_name, name: profile.name }
  if (!m.text && m.blocks) out.blocks = m.blocks
  if (m.reactions) out.reactions = m.reactions.map((r) => ({ name: r.name, users: r.users }))
  if (m.files) out.files = m.files.map((f) => ({ id: f.id, name: f.name, title: f.title, mode: f.mode }))
  return out
}

/** Messages in chunks of at most CHUNK_MESSAGES and CHUNK_BYTES of JSON. */
export function chunks(messages: Json[], maxCount = CHUNK_MESSAGES, maxBytes = CHUNK_BYTES): Json[][] {
  const out: Json[][] = []
  let chunk: Json[] = []
  let bytes = 0
  for (const m of messages) {
    const size = Buffer.byteLength(JSON.stringify(m))
    if (chunk.length && (chunk.length >= maxCount || bytes + size > maxBytes)) {
      out.push(chunk)
      chunk = []
      bytes = 0
    }
    chunk.push(m)
    bytes += size
  }
  if (chunk.length) out.push(chunk)
  return out
}

/**
 * Custom emoji: the seam for the emoji feature (docs/import.md). Today it
 * imports none and says how many it skipped; wiring it means adding each here
 * through that feature's method, the image fetched from `url` (an `alias:`
 * url is an alias).
 */
export async function importCustomEmoji(_s: Session, emoji: Record<string, string>) {
  return { imported: 0, skipped: Object.keys(emoji).length }
}

interface Options {
  dryRun: boolean
  files: "skip" | "download"
  sourceToken?: string
  sourceApi: string
  merge: boolean
  json: boolean
}

export async function importCommand(argv: string[], io: Io): Promise<number | void> {
  const [sub, ...rest] = argv
  const { values, positionals } = parse(rest, {
    "dry-run": { type: "boolean" },
    files: { type: "string" },
    "slack-token": { type: "string" },
    "slack-api": { type: "string" },
    "merge-into-existing": { type: "boolean" },
  })
  if (sub === "status") {
    const s = await session(io, values)
    return status(s, positionals[0], Boolean(values.json))
  }
  if (sub === "undo") {
    if (!positionals[0]) throw new UsageError("import undo needs a job id (from campflare import status)")
    return undo(await session(io, values), positionals[0], Boolean(values.json))
  }
  if (sub !== "slack") throw new UsageError("import takes slack <export.zip>, status [<job>] or undo <job>")
  const path = positionals[0]
  if (!path || positionals.length > 1) throw new UsageError("import slack needs one export zip")
  const files = str(values.files) ?? "skip"
  if (files !== "skip" && files !== "download") throw new UsageError("--files is skip or download")
  const sourceToken = str(values["slack-token"])
  if (files === "download" && !sourceToken) {
    throw new UsageError("--files download needs --slack-token (a token of the exported workspace, to fetch files)")
  }
  const options: Options = {
    dryRun: Boolean(values["dry-run"]),
    files,
    sourceToken,
    sourceApi: (str(values["slack-api"]) ?? "https://slack.com/api/").replace(/\/?$/, "/"),
    merge: Boolean(values["merge-into-existing"]),
    json: Boolean(values.json),
  }
  const s = await session(io, values)
  const zip = await openZip(io.openFile ? await io.openFile(path) : memoryAccess(await io.readFile(path)))
  try {
    const exported = await readExport(zip)
    if (options.dryRun) return await dryRun(s, exported, options)
    return await runImport(s, exported, options, basename(path))
  } finally {
    await zip.close()
  }
}

async function runImport(s: Session, ex: Export, options: Options, sourceName: string) {
  const { io, client } = s
  const progress = (line: string) => io.stderr(`${line}\n`)
  const started = await client.call<{ ok: boolean; job: JobJson; resumed: boolean }>("campflare.import.start", {
    format: "slack-export",
    fingerprint: ex.zip.fingerprint,
    merge_into_existing: options.merge,
    files: options.files,
    source_name: sourceName,
  })
  const job = started.job.id
  progress(`${started.resumed ? "Resuming" : "Started"} import ${job} of ${sourceName}`)
  const known = await client.call<{ ok: boolean; conversations: { source_id: string; cursor: string | null }[] }>(
    "campflare.import.status",
    { job },
  )
  const cursors = new Map(known.conversations.map((c) => [c.source_id, c.cursor]))

  for (let i = 0; i < ex.users.length; i += USERS_PER_CALL) {
    await client.call("campflare.import.users", { job, users: ex.users.slice(i, i + USERS_PER_CALL) })
  }
  progress(`People: ${ex.users.length}`)
  const mapped = new Map<string, { conversation_id: string | null; action: string; name?: string }>()
  for (let i = 0; i < ex.conversations.length; i += CONVERSATIONS_PER_CALL) {
    const slice = ex.conversations.slice(i, i + CONVERSATIONS_PER_CALL).map(conversationArgs)
    const res = await client.call<{
      ok: boolean
      conversations: { source_id: string; conversation_id: string | null; action: string; name?: string }[]
    }>("campflare.import.conversations", { job, conversations: slice })
    for (const c of res.conversations) mapped.set(c.source_id, c)
  }
  progress(`Conversations: ${ex.conversations.length}`)

  for (const c of ex.conversations) {
    const target = mapped.get(c.id)
    if (!target?.conversation_id) continue
    const cursor = cursors.get(c.id)
    const days = (ex.days.get(folderOf(c)) ?? []).filter((d) => !cursor || dayOf(d) > cursor)
    let sent = 0
    for (const day of days) {
      const list = await ex.json<ExportMessage[]>(day)
      const parts = chunks(list.map(trim))
      for (const [i, part] of parts.entries()) {
        const last = i === parts.length - 1
        await client.call("campflare.import.messages", {
          job,
          conversation: c.id,
          messages: part,
          ...(last ? { cursor: dayOf(day) } : {}),
        })
        sent += part.length
      }
    }
    const label = c.type === "channel" || c.type === "group" ? `#${target.name ?? c.name}` : `${c.type} ${c.id}`
    progress(`${label}: ${sent} messages${cursor ? ` (resumed after ${cursor})` : ""}`)
  }

  // Every file not attached yet, whatever the message cursors say: a re-run retries the ones that failed.
  const transfers =
    options.files === "download" ? await transferPending(s, ex, job, options) : { failed: [], external: [] }

  let emoji: { imported: number; skipped: number } | undefined
  if (options.sourceToken) emoji = await customEmoji(s, options)

  let finished: JobJson
  for (;;) {
    const res = await client.call<{ ok: boolean; done: boolean; job: JobJson }>("campflare.import.finish", { job })
    if (res.done) {
      finished = res.job
      break
    }
  }
  if (options.json) {
    s.print({
      job: finished,
      ...(transfers.failed.length ? { failed_files: transfers.failed } : {}),
      ...(transfers.external.length ? { external_files: transfers.external } : {}),
      ...(emoji ? { emoji } : {}),
    })
    return
  }
  io.stdout(summary(finished, transfers, emoji))
}

interface Needed {
  id: string
  /** The export's conversation. */
  conversation: string
  ts: string
  name: string
}

/**
 * Whether the source token may go to this URL: Slack's own https hosts
 * (files.slack.com, a workspace's <name>.slack.com), or the origin of
 * --slack-api. Anything else in an export (an external file, a crafted
 * export) never sees it.
 */
export function tokenMayGoTo(url: string, sourceApi: string): boolean {
  try {
    const u = new URL(url)
    if (u.username || u.password) return false
    if (u.protocol === "https:" && (u.hostname === "slack.com" || u.hostname.endsWith(".slack.com"))) return true
    return u.origin === new URL(sourceApi).origin
  } catch {
    return false
  }
}

interface Transfers {
  failed: string[]
  /** Files elsewhere than the source: not fetched, left as a line. */
  external: string[]
}

/** The files the server says are still to attach, page by page, transferred. */
async function transferPending(s: Session, ex: Export, job: string, options: Options): Promise<Transfers> {
  const done: Transfers = { failed: [], external: [] }
  const days = dayReader(ex)
  let after: string | null = null
  do {
    const page: { ok: boolean; files_needed: Needed[]; files_after: string | null } = await s.client.call(
      "campflare.import.status",
      { job, files_needed: true, files_after: after ?? undefined },
    )
    const res = await transferFiles(s, job, page.files_needed, days, options)
    done.failed.push(...res.failed)
    done.external.push(...res.external)
    after = page.files_after
  } while (after)
  return done
}

/**
 * Finds a message of the export by conversation and ts: in the day file of its
 * date (UTC), or the days either side (an export's days follow its time zone).
 * The last few day files read are kept.
 */
function dayReader(ex: Export) {
  const cache = new Map<string, ExportMessage[]>()
  const byId = new Map(ex.conversations.map((c) => [c.id, c]))
  return async (conversation: string, ts: string): Promise<ExportMessage | undefined> => {
    const c = byId.get(conversation)
    const entries = c ? (ex.days.get(folderOf(c)) ?? []) : []
    const at = Number(ts.split(".")[0]) * 1000
    for (const offset of [0, -1, 1]) {
      const name = `${new Date(at + offset * 86_400_000).toISOString().slice(0, 10)}.json`
      const entry = entries.find((e) => dayOf(e) === name)
      if (!entry) continue
      let list = cache.get(entry.name)
      if (!list) {
        if (cache.size >= 16) cache.clear()
        list = await ex.json<ExportMessage[]>(entry)
        cache.set(entry.name, list)
      }
      // Slack's ts are fixed width already, as the server stores them.
      const m = list.find((x) => x.ts === ts)
      if (m) return m
    }
    return undefined
  }
}

/** Downloads files from the source, uploads them here, and attaches them. */
async function transferFiles(
  s: Session,
  job: string,
  needed: Needed[],
  find: ReturnType<typeof dayReader>,
  options: Options,
): Promise<Transfers> {
  const fetch = s.io.fetch ?? globalThis.fetch
  const failed: string[] = []
  const external: string[] = []
  const byMessage = new Map<
    string,
    { conversation: string; ts: string; files: { source_id: string; file_id: string; title: string }[] }
  >()
  for (const need of needed) {
    const m = await find(need.conversation, need.ts)
    const file = m?.files?.find((f) => f.id === need.id)
    const url = file?.url_private_download ?? file?.url_private
    const name = need.name
    if (!url) {
      failed.push(`${name}: no download URL`)
      continue
    }
    if (file?.is_external || !tokenMayGoTo(url, options.sourceApi)) {
      external.push(name)
      continue
    }
    try {
      const res = await fetch(url, { headers: { authorization: `Bearer ${options.sourceToken}` } })
      // Slack answers a wrong token with its sign-in page, not an error status.
      if (!res.ok || (res.headers.get("content-type") ?? "").startsWith("text/html")) {
        throw new Error(res.ok ? "not authorized (check --slack-token)" : `HTTP ${res.status}`)
      }
      const bytes = new Uint8Array(await res.arrayBuffer())
      const { upload_url, file_id } = await s.client.call<{ ok: boolean; upload_url: string; file_id: string }>(
        "files.getUploadURLExternal",
        { filename: name, length: bytes.byteLength },
      )
      const put = await fetch(upload_url, {
        method: "POST",
        headers: { authorization: `Bearer ${s.profile.token}` },
        body: bytes,
      })
      if (!put.ok) throw new Error(`upload: HTTP ${put.status}`)
      const key = `${need.conversation}/${need.ts}`
      const entry = byMessage.get(key) ?? { conversation: need.conversation, ts: need.ts, files: [] }
      entry.files.push({ source_id: need.id, file_id, title: file?.title ?? name })
      byMessage.set(key, entry)
    } catch (error) {
      failed.push(`${name}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  for (const { conversation, ts, files } of byMessage.values()) {
    await s.client.call("campflare.import.files", { job, conversation, ts, files })
  }
  return { failed, external }
}

async function customEmoji(s: Session, options: Options) {
  const fetch = s.io.fetch ?? globalThis.fetch
  try {
    const res = await fetch(`${options.sourceApi}emoji.list`, {
      method: "POST",
      headers: { authorization: `Bearer ${options.sourceToken}` },
    })
    const body = (await res.json()) as { ok: boolean; emoji?: Record<string, string>; error?: string }
    if (!body.ok) throw new Error(body.error ?? "not ok")
    return await importCustomEmoji(s, body.emoji ?? {})
  } catch (error) {
    s.io.stderr(`Couldn't list the export's custom emoji: ${error instanceof Error ? error.message : String(error)}\n`)
    return undefined
  }
}

function summary(job: JobJson, transfers: Transfers, emoji?: { imported: number; skipped: number }): string {
  const c = job.counts
  const lines = [
    `Imported ${job.options.source_name ?? "the export"} as job ${job.id} (${job.state})`,
    `  people         ${c.users_mapped} matched by email, ${c.users_created} placeholders (deactivated)`,
    `  conversations  ${c.conversations_created} created, ${c.conversations_renamed} renamed, ` +
      `${c.conversations_merged} merged, ${c.conversations_skipped} skipped`,
    `  messages       ${c.messages}, ${c.reactions} reactions, ${c.pins} pins` +
      (c.messages_skipped ? `; ${c.messages_skipped} skipped (a message was already there)` : ""),
    `  files          ${c.files_attached} attached, ${c.files_skipped} left as a line` +
      (job.options.files === "skip" && c.files_skipped ? " (--files download --slack-token to bring them)" : ""),
  ]
  if (c.unmapped_users.length) lines.push(`  unmapped       ${c.unmapped_users.join(", ")} (not in users.json)`)
  for (const f of transfers.failed) lines.push(`  file failed    ${f}`)
  if (transfers.external.length) {
    lines.push(`  external       ${transfers.external.join(", ")} (links elsewhere: not fetched, left as a line)`)
  }
  if (emoji) lines.push(`  custom emoji   ${emoji.imported} imported, ${emoji.skipped} skipped (not supported yet)`)
  lines.push(`Undo (within 7 days): campflare import undo ${job.id}`)
  return `${lines.join("\n")}\n`
}

/** What an import would do, from the export and the workspace as they are; nothing is written. */
async function dryRun(s: Session, ex: Export, options: Options) {
  const client: Client = s.client
  const people = await client.paginate<{ id: string; name: string; profile?: { email?: string } }>(
    "users.list",
    "members",
  )
  const emails = new Map(people.flatMap((p) => (p.profile?.email ? [[p.profile.email.toLowerCase(), p.name]] : [])))
  const channels = await client.paginate<{ name: string; is_private?: boolean }>("conversations.list", "channels", {
    types: "public_channel,private_channel",
    exclude_archived: false,
  })
  const privacy = new Map(channels.map((c) => [c.name, Boolean(c.is_private)]))
  const matched: string[] = []
  const placeholders: string[] = []
  for (const u of ex.users) {
    const match = u.profile?.email && emails.get(u.profile.email.toLowerCase())
    if (match) matched.push(`${u.name ?? u.id} → @${match}`)
    else placeholders.push(u.name ?? u.id)
  }
  const clashes: string[] = []
  for (const c of ex.conversations) {
    const taken = c.name === undefined ? undefined : privacy.get(c.name.toLowerCase())
    if ((c.type === "channel" || c.type === "group") && taken !== undefined) {
      // Merged only into one as private as it was, as the server does.
      const merge = options.merge && taken === (c.type === "group")
      clashes.push(`#${c.name} ${merge ? "merged into the existing one" : `renamed #${c.name}-imported`}`)
    }
  }
  let messages = 0
  let files = 0
  for (const entries of ex.days.values()) {
    for (const day of entries) {
      const list = await ex.json<ExportMessage[]>(day)
      messages += list.length
      files += list.reduce((n, m) => n + (m.files?.length ?? 0), 0)
    }
  }
  const plan = {
    dry_run: true,
    users: { total: ex.users.length, matched, placeholders },
    conversations: { total: ex.conversations.length, clashes },
    messages,
    files: { total: files, action: options.files },
  }
  if (options.json) return s.print(plan)
  s.io.stdout(
    [
      "Dry run: nothing was written.",
      `  people         ${ex.users.length}: ${matched.length} match by email, ${placeholders.length} would be placeholders`,
      ...matched.map((m) => `                   ${m}`),
      `  conversations  ${ex.conversations.length}${clashes.length ? `, ${clashes.length} taken here:` : ""}`,
      ...clashes.map((c) => `                   ${c}`),
      `  messages       ${messages}`,
      `  files          ${files} (${options.files === "download" ? "downloaded" : "left as a line each"})`,
      "",
    ].join("\n"),
  )
}

async function status(s: Session, job: string | undefined, json: boolean) {
  if (job) {
    const res = await s.client.call<{ ok: boolean; job: JobJson; conversations: unknown[] }>(
      "campflare.import.status",
      { job },
    )
    if (json) return s.print({ job: res.job, conversations: res.conversations })
    return s.io.stdout(jobLine(res.job) + countsLine(res.job))
  }
  const res = await s.client.call<{ ok: boolean; jobs: JobJson[] }>("campflare.import.list")
  if (json) return s.print(res.jobs)
  if (!res.jobs.length) return s.io.stdout("No imports yet\n")
  s.io.stdout(res.jobs.map(jobLine).join(""))
}

const jobLine = (job: JobJson) =>
  `${job.id}  ${job.state}  ${job.options.source_name ?? job.options.files}  ${new Date(job.created * 1000).toISOString()}\n`

const countsLine = (job: JobJson) =>
  `  ${job.counts.messages} messages, ${job.counts.users_created} placeholders, ` +
  `${job.counts.conversations_created + job.counts.conversations_renamed} conversations created\n`

async function undo(s: Session, job: string, json: boolean) {
  const removed: Record<string, number> = {}
  let last: JobJson
  for (;;) {
    const res = await s.client.call<{ ok: boolean; done: boolean; removed: Record<string, number>; job: JobJson }>(
      "campflare.import.undo",
      { job },
    )
    for (const [k, v] of Object.entries(res.removed)) removed[k] = (removed[k] ?? 0) + v
    if (!json) s.io.stderr(".")
    if (res.done) {
      last = res.job
      break
    }
  }
  if (json) return s.print({ job: last, removed })
  const parts = Object.entries(removed).map(([k, v]) => `${v} ${k}`)
  s.io.stdout(`\nUndid import ${job}${parts.length ? `: removed ${parts.join(", ")}` : ""}\n`)
}
