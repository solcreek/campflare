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

/** A ts as the server stores it: fixed width. */
const normalTs = (ts: string) => {
  const [seconds = "0", micros = ""] = ts.split(".")
  return `${seconds.padStart(10, "0")}.${micros.padEnd(6, "0").slice(0, 6)}`
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
  slackToken?: string
  slackApi: string
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
  const slackToken = str(values["slack-token"]) ?? io.env.SLACK_TOKEN
  if (files === "download" && !slackToken) {
    throw new UsageError("--files download needs --slack-token (a token of the exported workspace, to fetch files)")
  }
  const options: Options = {
    dryRun: Boolean(values["dry-run"]),
    files,
    slackToken,
    slackApi: (str(values["slack-api"]) ?? "https://slack.com/api/").replace(/\/?$/, "/"),
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

  const failedFiles: string[] = []
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
        const res = await client.call<{ ok: boolean; files_needed: { id: string; ts: string }[] }>(
          "campflare.import.messages",
          { job, conversation: c.id, messages: part, ...(last ? { cursor: dayOf(day) } : {}) },
        )
        sent += part.length
        if (options.files === "download" && res.files_needed.length) {
          failedFiles.push(...(await transferFiles(s, job, c.id, list, res.files_needed, options.slackToken!)))
        }
      }
    }
    const label = c.type === "channel" || c.type === "group" ? `#${target.name ?? c.name}` : `${c.type} ${c.id}`
    progress(`${label}: ${sent} messages${cursor ? ` (resumed after ${cursor})` : ""}`)
  }

  let emoji: { imported: number; skipped: number } | undefined
  if (options.slackToken) emoji = await customEmoji(s, options)

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
      ...(failedFiles.length ? { failed_files: failedFiles } : {}),
      ...(emoji ? { emoji } : {}),
    })
    return
  }
  io.stdout(summary(finished, failedFiles, emoji))
}

/** Downloads the files a chunk still needs from Slack, uploads them here, and attaches them; the ones that failed. */
async function transferFiles(
  s: Session,
  job: string,
  conversation: string,
  day: ExportMessage[],
  needed: { id: string; ts: string }[],
  slackToken: string,
): Promise<string[]> {
  const fetch = s.io.fetch ?? globalThis.fetch
  const failed: string[] = []
  const byTs = new Map<string, { source_id: string; file_id: string; title: string }[]>()
  for (const need of needed) {
    const m = day.find((x) => normalTs(String(x.ts)) === need.ts)
    const file = m?.files?.find((f) => f.id === need.id)
    const url = file?.url_private_download ?? file?.url_private
    const name = file?.name ?? need.id
    if (!url) {
      failed.push(`${name}: no download URL`)
      continue
    }
    try {
      const res = await fetch(url, { headers: { authorization: `Bearer ${slackToken}` } })
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
      byTs.set(need.ts, [...(byTs.get(need.ts) ?? []), { source_id: need.id, file_id, title: file?.title ?? name }])
    } catch (error) {
      failed.push(`${name}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  for (const [ts, files] of byTs) {
    await s.client.call("campflare.import.files", { job, conversation, ts, files })
  }
  return failed
}

async function customEmoji(s: Session, options: Options) {
  const fetch = s.io.fetch ?? globalThis.fetch
  try {
    const res = await fetch(`${options.slackApi}emoji.list`, {
      method: "POST",
      headers: { authorization: `Bearer ${options.slackToken}` },
    })
    const body = (await res.json()) as { ok: boolean; emoji?: Record<string, string>; error?: string }
    if (!body.ok) throw new Error(body.error ?? "not ok")
    return await importCustomEmoji(s, body.emoji ?? {})
  } catch (error) {
    s.io.stderr(`Couldn't list the export's custom emoji: ${error instanceof Error ? error.message : String(error)}\n`)
    return undefined
  }
}

function summary(job: JobJson, failedFiles: string[], emoji?: { imported: number; skipped: number }): string {
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
  for (const f of failedFiles) lines.push(`  file failed    ${f}`)
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
  const channels = await client.paginate<{ name: string; is_general?: boolean }>("conversations.list", "channels", {
    types: "public_channel,private_channel",
    exclude_archived: false,
  })
  const names = new Set(channels.map((c) => c.name))
  const matched: string[] = []
  const placeholders: string[] = []
  for (const u of ex.users) {
    const match = u.profile?.email && emails.get(u.profile.email.toLowerCase())
    if (match) matched.push(`${u.name ?? u.id} → @${match}`)
    else placeholders.push(u.name ?? u.id)
  }
  const clashes: string[] = []
  for (const c of ex.conversations) {
    if ((c.type === "channel" || c.type === "group") && c.name && names.has(c.name.toLowerCase())) {
      clashes.push(`#${c.name} ${options.merge ? "merged into the existing one" : `renamed #${c.name}-imported`}`)
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
