import { requireMember, requireWritable, resolveConversation } from "../db/conversations"
import { announceChanged, postMessage, reactionsStatement, MAX_TEXT } from "../db/messages"
import { first, stmt } from "../db/query"
import type { AppRow, ConversationRow, MessageRow, ReactionRow } from "../db/rows"
import { audienceFrom, audienceStatement } from "../events"
import { method, type Actor, type Ctx } from "../api/context"
import { CampflareError } from "../api/errors"
import { knownExtras, loadExtras, messageJson } from "../api/shapes"
import { withBlockIds } from "./chat"

// Slack's text streaming: chat.startStream posts a message an app then grows
// with chat.appendStream and finishes with chat.stopStream.
// https://docs.slack.dev/messaging/sending-and-scheduling-messages#text-streaming
//
// The message is stored as it grows: `text` is all its markdown so far, and
// `blocks` holds it as `markdown` blocks, with any blocks the app streamed or
// attached on stop in the order they came; consecutive markdown extends the
// last markdown block. Start publishes a `message`, every change a
// `message_changed`, so other clients watch it grow. `streaming_state` says
// "in_progress" until stopped, then "completed".
//
// task_update and plan_update chunks become Slack's own blocks: each task a
// `task_card` (its text details and output as rich_text), updated in place by
// its id, either among the text (task_display_mode "timeline", the default) or
// in the `tasks` of one `plan` block ("plan"), whose title plan_update sets.

/** Markdown per call, as Slack limits it. */
const MAX_MARKDOWN = 12_000
const MAX_BLOCKS = 50
const TASK_STATUSES = new Set(["pending", "in_progress", "complete", "error"])
/** How often a change built from the row read before it is tried again when the row moved meanwhile. */
const MAX_ATTEMPTS = 5

type Mode = "markdown_text" | "chunks"
type Block = Record<string, unknown>

/** One step of what a call adds, in the order it came. */
type Op =
  | { kind: "markdown"; text: string }
  | { kind: "blocks"; blocks: Block[] }
  /** A task_update chunk as the `task_card` block it becomes (block_id aside). */
  | { kind: "task"; task: Block }
  /** A plan_update chunk: the plan's title. */
  | { kind: "plan"; title: string }

/** What one call adds. */
interface Content {
  /** How the call sent content; absent when it sent none. */
  mode?: Mode
  /** Markdown, blocks, task and plan updates, in order. */
  ops: Op[]
  /** All the call's markdown, for the message's text. */
  markdown: string
  /**
   * Has task or plan updates. They change blocks already there (a task by its
   * id, the plan's title), which the SQL that appends can't do: see grow().
   */
  structural: boolean
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v)

/** A task's details or output, sent as text, as the rich_text block a task_card holds. */
const richText = (text: string): Block => ({
  type: "rich_text",
  elements: [{ type: "rich_text_section", elements: [{ type: "text", text }] }],
})

const isSource = (s: unknown) =>
  isObject(s) && s.type === "url" && typeof s.url === "string" && typeof s.text === "string"

/** A task_update chunk as Slack's task_card block, which has the same fields. */
function taskCard(chunk: Record<string, unknown>): Block {
  const { id, title, status, details, output, sources } = chunk
  if (typeof id !== "string" || !id || typeof title !== "string" || !TASK_STATUSES.has(String(status)))
    throw new CampflareError("invalid_chunks")
  if (details !== undefined && typeof details !== "string") throw new CampflareError("invalid_chunks")
  if (output !== undefined && typeof output !== "string") throw new CampflareError("invalid_chunks")
  if (sources !== undefined && (!Array.isArray(sources) || !sources.every(isSource)))
    throw new CampflareError("invalid_chunks")
  return {
    type: "task_card",
    task_id: id,
    title,
    status,
    ...(details !== undefined ? { details: richText(details) } : {}),
    ...(output !== undefined ? { output: richText(output) } : {}),
    ...(sources !== undefined ? { sources } : {}),
  }
}

function chunkOp(chunk: unknown): Op {
  if (!isObject(chunk)) throw new CampflareError("invalid_chunks")
  switch (chunk.type) {
    case "markdown_text":
      if (typeof chunk.text !== "string") throw new CampflareError("invalid_chunks")
      return { kind: "markdown", text: chunk.text }
    case "blocks":
      if (!Array.isArray(chunk.blocks) || !chunk.blocks.every(isObject)) throw new CampflareError("invalid_chunks")
      return { kind: "blocks", blocks: withBlockIds(chunk.blocks) as Block[] }
    case "task_update":
      return { kind: "task", task: taskCard(chunk) }
    case "plan_update":
      if (typeof chunk.title !== "string") throw new CampflareError("invalid_chunks")
      return { kind: "plan", title: chunk.title }
    default:
      throw new CampflareError("invalid_chunks")
  }
}

/** markdown_text or chunks (never both), as one call gives them. */
function content(ctx: Ctx<Actor>, required: boolean): Content {
  const markdown = ctx.args.str("markdown_text")
  const chunks = ctx.args.json<unknown>("chunks", "invalid_chunks")
  if (markdown !== undefined && chunks !== undefined)
    throw new CampflareError("cannot_provide_both_markdown_text_and_chunks")
  const out: Content = { ops: [], markdown: "", structural: false }
  if (markdown !== undefined) {
    out.mode = "markdown_text"
    out.ops.push({ kind: "markdown", text: markdown })
  } else if (chunks !== undefined) {
    if (!Array.isArray(chunks)) throw new CampflareError("invalid_chunks")
    if (chunks.length > 0) out.mode = "chunks"
    out.ops = chunks.map(chunkOp)
  }
  if (required && !out.mode) throw new CampflareError("markdown_text_or_chunks_required")
  for (const op of out.ops) {
    if (op.kind === "markdown") out.markdown += op.text
    else if (op.kind !== "blocks") out.structural = true
  }
  if (out.markdown.length > MAX_MARKDOWN) throw new CampflareError("msg_too_long")
  return out
}

/** A task added at the end of a list of blocks, or merged into the task_card with its id where it is. */
function upsertTask(list: Block[], task: Block): Block[] {
  const i = list.findIndex((b) => b.type === "task_card" && b.task_id === task.task_id)
  if (i < 0) return [...list, ...(withBlockIds([task]) as Block[])]
  return list.with(i, { ...list[i], ...task })
}

/**
 * A call's content added to a message's blocks. Markdown extends the last
 * block when that is markdown, else starts one; blocks go after. A task
 * becomes a `task_card` block among the rest (timeline, the default) or one of
 * the `plan` block's `tasks` (plan mode), and an update to a task already there
 * changes it in place. A plan update titles the message's one `plan` block,
 * which the first plan update (or, in plan mode, task) makes.
 */
function applyOps(start: Block[], ops: Op[], planMode: boolean): Block[] {
  let blocks = [...start]
  const planAt = () => {
    const i = blocks.findIndex((b) => b.type === "plan")
    if (i >= 0) return i
    blocks.push(...(withBlockIds([{ type: "plan", title: "", tasks: [] }]) as Block[]))
    return blocks.length - 1
  }
  for (const op of ops) {
    if (op.kind === "markdown") {
      const last = blocks.at(-1)
      if (last?.type === "markdown") blocks[blocks.length - 1] = { ...last, text: `${String(last.text)}${op.text}` }
      else if (op.text) blocks.push({ type: "markdown", text: op.text })
    } else if (op.kind === "blocks") {
      blocks.push(...op.blocks)
    } else if (op.kind === "plan") {
      const i = planAt()
      blocks[i] = { ...blocks[i], title: op.title }
    } else if (planMode) {
      const i = planAt()
      const tasks = Array.isArray(blocks[i]!.tasks) ? (blocks[i]!.tasks as Block[]) : []
      blocks[i] = { ...blocks[i], tasks: upsertTask(tasks, op.task) }
    } else {
      blocks = upsertTask(blocks, op.task)
    }
  }
  return blocks
}

/**
 * A call without task or plan updates as SQL appends it: the markdown it
 * starts with (which may extend the message's last block), then new blocks.
 */
function appendable(body: Content): { lead?: string; tail: Block[] } {
  let lead = ""
  let i = 0
  for (; i < body.ops.length; i++) {
    const op = body.ops[i]!
    if (op.kind !== "markdown") break
    lead += op.text
  }
  return { ...(lead ? { lead } : {}), tail: applyOps([], body.ops.slice(i), false) }
}

/** blocks on chat.stopStream: rendered at the bottom of the finished message. */
function closingBlocks(ctx: Ctx<Actor>): Block[] {
  const blocks = ctx.args.json<unknown>("blocks", "invalid_blocks")
  if (blocks === undefined) return []
  if (!Array.isArray(blocks) || !blocks.every(isObject)) throw new CampflareError("invalid_blocks")
  if (blocks.length > MAX_BLOCKS) throw new CampflareError("msg_blocks_too_many")
  return withBlockIds(blocks) as Block[]
}

function botApp(ctx: Ctx<Actor>) {
  // The method is bot-only, and every bot token belongs to an app.
  return ctx.auth.app!
}

method("chat.startStream", "bot", async (ctx) => {
  const c = await resolveConversation(ctx, ctx.args.req("channel", "channel_not_found"))
  await requireWritable(ctx, c)
  // "0" is Slack's way of saying no thread.
  const threadTs = ctx.args.str("thread_ts") === "0" ? undefined : ctx.args.ts("thread_ts")
  if (c.kind !== "im") await requireRecipient(ctx)
  const body = content(ctx, false)
  // "timeline" (the default) shows tasks as task_card blocks among the text, "plan" gathers them in a plan block.
  const planMode = ctx.args.str("task_display_mode") === "plan"
  const blocks = applyOps([], body.ops, planMode)
  if (blocks.length > MAX_BLOCKS) throw new CampflareError("msg_blocks_too_many")
  const app = botApp(ctx)
  const { row } = await postMessage(ctx, c, {
    user_id: ctx.auth.user.id,
    bot_id: app.bot_id,
    app_id: app.id,
    username: ctx.args.str("username") ?? null,
    text: body.markdown,
    blocks: blocks.length > 0 ? JSON.stringify(blocks) : null,
    thread_ts: threadTs ?? null,
    stream_state: "in_progress",
    stream_mode: body.mode ?? null,
    stream_task_display: planMode ? "plan" : null,
  })
  return { channel: c.id, ts: row.ts }
})

/**
 * Outside a DM, Slack wants to know whom the stream answers: a person of the
 * workspace. Campflare checks them and shows the stream to the conversation as usual.
 */
async function requireRecipient(ctx: Ctx<Actor>) {
  const user = ctx.args.str("recipient_user_id")
  if (!user) throw new CampflareError("missing_recipient_user_id")
  const team = ctx.args.str("recipient_team_id")
  if (!team) throw new CampflareError("missing_recipient_team_id")
  if (team !== ctx.auth.team.id) throw new CampflareError("team_not_found")
  const found = await first(ctx.env.DB, "SELECT 1 FROM users WHERE id = ? AND team_id = ? AND deleted = 0", user, team)
  if (!found) throw new CampflareError("user_not_found")
}

method("chat.appendStream", "bot", async (ctx) => {
  const { c, after } = await grow(ctx, content(ctx, true), { stop: false })
  return { channel: c.id, ts: after.ts }
})

method("chat.stopStream", "bot", async (ctx) => {
  const body = content(ctx, false)
  const metadata = ctx.args.json<unknown>("metadata", "invalid_metadata_format")
  if (metadata !== undefined && !isObject(metadata)) throw new CampflareError("invalid_metadata_format")
  const { c, message } = await grow(ctx, body, {
    stop: true,
    closing: closingBlocks(ctx),
    metadata: metadata === undefined ? null : JSON.stringify(metadata),
  })
  return { channel: c.id, ts: message.ts, message }
})

/** What a change to a stream read and wrote: the row before and after, the audience and the reactions. */
interface Change {
  old: MessageRow
  row: MessageRow
  audience: D1Result
  reactions: D1Result
}

/**
 * Adds a call's content to a streaming message (and on stop, its closing blocks,
 * metadata and the completed state), then announces the change.
 */
async function grow(
  ctx: Ctx<Actor>,
  body: Content,
  opts: { stop: boolean; closing?: Block[]; metadata?: string | null },
): Promise<{ c: ConversationRow; after: MessageRow; message: ReturnType<typeof messageJson> }> {
  const c = await resolveConversation(ctx, ctx.args.req("channel", "channel_not_found"))
  await requireWritable(ctx, c)
  const ts = ctx.args.ts("ts")
  if (!ts) throw new CampflareError("message_not_found")
  const app = botApp(ctx)
  const change = body.structural
    ? await rewrite(ctx, c, ts, app, body, opts)
    : await append(ctx, c, ts, app, body, opts)
  const { old, row } = change
  const extras = knownExtras(change.reactions.results as ReactionRow[], [app])
  // A call that changes nothing shown (an empty chunk list) sends no event.
  const changed = row.text !== old.text || row.blocks !== old.blocks || row.stream_state !== old.stream_state
  const message = changed
    ? announceChanged(ctx, c, { before: old, after: row, audience: audienceFrom(change.audience), extras })
    : messageJson(row, extras, ctx.origin)
  return { c, after: row, message }
}

type GrowOptions = Parameters<typeof grow>[2]

/**
 * The common case, markdown and blocks, as one guarded UPDATE that builds the
 * blocks in SQL. The checks, the change, the rows before and after, the
 * audience and the reactions are one batch: one round trip after the
 * conversation, and the checks see what the change sees.
 */
async function append(
  ctx: Ctx<Actor>,
  c: ConversationRow,
  ts: string,
  app: AppRow,
  body: Content,
  opts: GrowOptions,
): Promise<Change> {
  const { lead, tail: added } = appendable(body)
  const tail = [...added, ...(opts.closing ?? [])]
  if (tail.length > MAX_BLOCKS) throw new CampflareError("msg_blocks_too_many")
  // The lead extends the last markdown block, or becomes a block of its own.
  let blocks = "COALESCE(blocks, '[]')"
  const blockParams: unknown[] = []
  if (lead !== undefined) {
    blocks = `CASE WHEN json_extract(blocks, '$[#-1].type') = 'markdown'
      THEN json_set(blocks, '$[#-1].text', json_extract(blocks, '$[#-1].text') || ?)
      ELSE json_insert(${blocks}, '$[#]', json_object('type', 'markdown', 'text', ?)) END`
    blockParams.push(lead, lead)
  }
  if (tail.length > 0) {
    blocks = `json_insert(${blocks}, ${tail.map(() => "'$[#]', json(?)").join(", ")})`
    blockParams.push(...tail.map((b) => JSON.stringify(b)))
  }
  const changesBlocks = lead !== undefined || tail.length > 0
  const count = tail.length + (lead !== undefined ? 1 : 0)

  const db = ctx.env.DB
  const select = stmt(db, "SELECT * FROM messages WHERE channel_id = ? AND ts = ? AND deleted = 0", c.id, ts)
  const [before, update, after, audience, reactions] = await db.batch([
    select,
    stmt(
      db,
      `UPDATE messages SET
         text = text || ?,
         blocks = ${changesBlocks ? blocks : "blocks"},
         stream_mode = COALESCE(stream_mode, ?),
         stream_state = ?,
         metadata = COALESCE(?, metadata)
       WHERE channel_id = ? AND ts = ? AND deleted = 0 AND app_id = ? AND stream_state = 'in_progress'
         AND (? IS NULL OR stream_mode IS NULL OR stream_mode = ?)
         AND length(text) + ? <= ?
         AND json_array_length(COALESCE(blocks, '[]')) + ?
           - (CASE WHEN ? AND json_extract(blocks, '$[#-1].type') = 'markdown' THEN 1 ELSE 0 END) <= ?`,
      body.markdown,
      ...(changesBlocks ? blockParams : []),
      body.mode ?? null,
      opts.stop ? "completed" : "in_progress",
      opts.metadata ?? null,
      c.id,
      ts,
      app.id,
      body.mode ?? null,
      body.mode ?? null,
      body.markdown.length,
      MAX_TEXT,
      count,
      lead !== undefined ? 1 : 0,
      MAX_BLOCKS,
    ),
    select,
    audienceStatement(db, c.id),
    reactionsStatement(db, c.id, ts),
  ])
  const old = before!.results[0] as MessageRow | undefined
  if (!update!.meta.changes) throw refusal(old, app.id, body) ?? new CampflareError("msg_blocks_too_many")
  return { old: old!, row: after!.results[0] as MessageRow, audience: audience!, reactions: reactions! }
}

/**
 * Task and plan updates change blocks already there, so the new blocks are
 * built here from the row as read, and written only if the row is still what
 * was read (compare and swap); a stream that moved meanwhile is read again.
 * Two round trips after the conversation.
 */
async function rewrite(
  ctx: Ctx<Actor>,
  c: ConversationRow,
  ts: string,
  app: AppRow,
  body: Content,
  opts: GrowOptions,
): Promise<Change> {
  const db = ctx.env.DB
  const select = stmt(db, "SELECT * FROM messages WHERE channel_id = ? AND ts = ? AND deleted = 0", c.id, ts)
  for (let attempt = 1; ; attempt++) {
    const [before, audience, reactions] = await db.batch([
      select,
      audienceStatement(db, c.id),
      reactionsStatement(db, c.id, ts),
    ])
    const old = before!.results[0] as MessageRow | undefined
    const refused = refusal(old, app.id, body)
    if (refused) throw refused
    const start = old!.blocks ? (JSON.parse(old!.blocks) as Block[]) : []
    const blocks = [...applyOps(start, body.ops, old!.stream_task_display === "plan"), ...(opts.closing ?? [])]
    if (blocks.length > MAX_BLOCKS) throw new CampflareError("msg_blocks_too_many")
    const [update, after] = await db.batch([
      stmt(
        db,
        `UPDATE messages SET
           text = ?, blocks = ?, stream_mode = COALESCE(stream_mode, ?), stream_state = ?,
           metadata = COALESCE(?, metadata)
         WHERE channel_id = ? AND ts = ? AND deleted = 0 AND stream_state = 'in_progress'
           AND text = ? AND blocks IS ?`,
        old!.text + body.markdown,
        blocks.length > 0 ? JSON.stringify(blocks) : null,
        body.mode ?? null,
        opts.stop ? "completed" : "in_progress",
        opts.metadata ?? null,
        c.id,
        ts,
        old!.text,
        old!.blocks,
      ),
      select,
    ])
    if (update!.meta.changes) {
      return { old: old!, row: after!.results[0] as MessageRow, audience: audience!, reactions: reactions! }
    }
    if (attempt === MAX_ATTEMPTS) throw new CampflareError("internal_error")
  }
}

/** Why a change to a stream can't be made, from the row it found; undefined when only the block limit is left. */
function refusal(row: MessageRow | undefined, appId: string, body: Content): CampflareError | undefined {
  if (!row) return new CampflareError("message_not_found")
  if (row.app_id !== appId) return new CampflareError("message_not_owned_by_app")
  if (row.stream_stopped_by) return new CampflareError("stopped_by_user")
  if (row.stream_state !== "in_progress") return new CampflareError("message_not_in_streaming_state")
  if (body.mode && row.stream_mode && row.stream_mode !== body.mode)
    return new CampflareError("streaming_mode_mismatch")
  if (row.text.length + body.markdown.length > MAX_TEXT) return new CampflareError("msg_too_long")
  return undefined
}

/**
 * A person in the conversation stops an app's stream from their client, as
 * Slack's stop button does: the message is completed as it stands, and the
 * app's next chat.appendStream (or chat.stopStream) answers `stopped_by_user`.
 */
method("campflare.chat.stopStream", "user", async (ctx) => {
  const c = await resolveConversation(ctx, ctx.args.req("channel", "channel_not_found"))
  await requireMember(ctx, c)
  const ts = ctx.args.ts("ts")
  if (!ts) throw new CampflareError("message_not_found")
  const db = ctx.env.DB
  const select = stmt(db, "SELECT * FROM messages WHERE channel_id = ? AND ts = ? AND deleted = 0", c.id, ts)
  const [before, update, after, audience, reactions] = await db.batch([
    select,
    stmt(
      db,
      `UPDATE messages SET stream_state = 'completed', stream_stopped_by = ?
       WHERE channel_id = ? AND ts = ? AND deleted = 0 AND stream_state = 'in_progress'`,
      ctx.auth.user.id,
      c.id,
      ts,
    ),
    select,
    audienceStatement(db, c.id),
    reactionsStatement(db, c.id, ts),
  ])
  const old = before!.results[0] as MessageRow | undefined
  if (!old) throw new CampflareError("message_not_found")
  if (!update!.meta.changes) throw new CampflareError("message_not_in_streaming_state")
  const row = after!.results[0] as MessageRow
  const extras = await loadExtras(ctx.env, [row], reactions!.results as ReactionRow[])
  const message = announceChanged(ctx, c, { before: old, after: row, audience: audienceFrom(audience!), extras })
  return { channel: c.id, ts, message }
})
