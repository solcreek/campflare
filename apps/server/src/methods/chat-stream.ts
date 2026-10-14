import { requireWritable, resolveConversation } from "../db/conversations"
import { announceChanged, postMessage, reactionsStatement, MAX_TEXT } from "../db/messages"
import { first, stmt } from "../db/query"
import type { ConversationRow, MessageRow, ReactionRow } from "../db/rows"
import { audienceFrom, audienceStatement } from "../events"
import { method, type Actor, type Ctx } from "../api/context"
import { CampflareError } from "../api/errors"
import { knownExtras, messageJson } from "../api/shapes"
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

/** Markdown per call, as Slack limits it. */
const MAX_MARKDOWN = 12_000
const MAX_BLOCKS = 50
const TASK_STATUSES = new Set(["pending", "in_progress", "complete", "error"])

type Mode = "markdown_text" | "chunks"
type Block = Record<string, unknown>

/** What one call adds: markdown and blocks in order, consecutive markdown joined. */
interface Content {
  /** How the call sent content; absent when it sent none. */
  mode?: Mode
  /** Markdown first, if the call starts with markdown: it may extend the message's last markdown block. */
  lead?: string
  /** Blocks after the lead, markdown among them as `markdown` blocks. */
  blocks: Block[]
  /** All the call's markdown, for the message's text. */
  markdown: string
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v)

/** A chunk's blocks, or undefined for a chunk that shows nothing here (task and plan updates). */
function chunkContent(chunk: unknown): string | Block[] | undefined {
  if (!isObject(chunk)) throw new CampflareError("invalid_chunks")
  switch (chunk.type) {
    case "markdown_text":
      if (typeof chunk.text !== "string") throw new CampflareError("invalid_chunks")
      return chunk.text
    case "blocks":
      if (!Array.isArray(chunk.blocks) || !chunk.blocks.every(isObject)) throw new CampflareError("invalid_chunks")
      return withBlockIds(chunk.blocks) as Block[]
    case "task_update":
      if (typeof chunk.id !== "string" || typeof chunk.title !== "string" || !TASK_STATUSES.has(String(chunk.status)))
        throw new CampflareError("invalid_chunks")
      return undefined
    case "plan_update":
      if (typeof chunk.title !== "string") throw new CampflareError("invalid_chunks")
      return undefined
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
  const pieces: (string | Block[])[] = []
  let mode: Mode | undefined
  if (markdown !== undefined) {
    mode = "markdown_text"
    pieces.push(markdown)
  } else if (chunks !== undefined) {
    if (!Array.isArray(chunks)) throw new CampflareError("invalid_chunks")
    if (chunks.length > 0) mode = "chunks"
    for (const chunk of chunks) {
      const piece = chunkContent(chunk)
      if (piece !== undefined && piece.length > 0) pieces.push(piece)
    }
  }
  if (required && !mode) throw new CampflareError("markdown_text_or_chunks_required")

  const out: Content = { mode, blocks: [], markdown: "" }
  for (const piece of pieces) {
    if (Array.isArray(piece)) {
      out.blocks.push(...piece)
      continue
    }
    out.markdown += piece
    const last = out.blocks.at(-1)
    if (last?.type === "markdown") last.text = `${String(last.text)}${piece}`
    else if (out.blocks.length === 0 && out.lead !== undefined) out.lead += piece
    else if (out.blocks.length === 0) out.lead = piece
    else out.blocks.push({ type: "markdown", text: piece })
  }
  if (out.markdown.length > MAX_MARKDOWN) throw new CampflareError("msg_too_long")
  return out
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
  const blocks = [...(body.lead !== undefined ? [{ type: "markdown", text: body.lead }] : []), ...body.blocks]
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

/**
 * Adds a call's content to a streaming message (and on stop, its closing blocks,
 * metadata and the completed state), then announces the change. The checks, the
 * change, the rows before and after, the audience and the reactions are one batch:
 * one round trip after the conversation, and the checks see what the change sees.
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

  const tail = [...body.blocks, ...(opts.closing ?? [])]
  if (tail.length > MAX_BLOCKS) throw new CampflareError("msg_blocks_too_many")
  // The lead extends the last markdown block, or becomes a block of its own.
  const lead = body.lead !== undefined
  let blocks = "COALESCE(blocks, '[]')"
  const blockParams: unknown[] = []
  if (lead) {
    blocks = `CASE WHEN json_extract(blocks, '$[#-1].type') = 'markdown'
      THEN json_set(blocks, '$[#-1].text', json_extract(blocks, '$[#-1].text') || ?)
      ELSE json_insert(${blocks}, '$[#]', json_object('type', 'markdown', 'text', ?)) END`
    blockParams.push(body.lead, body.lead)
  }
  if (tail.length > 0) {
    blocks = `json_insert(${blocks}, ${tail.map(() => "'$[#]', json(?)").join(", ")})`
    blockParams.push(...tail.map((b) => JSON.stringify(b)))
  }
  const changesBlocks = lead || tail.length > 0
  const added = tail.length + (lead ? 1 : 0)

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
      added,
      lead ? 1 : 0,
      MAX_BLOCKS,
    ),
    select,
    audienceStatement(db, c.id),
    reactionsStatement(db, c.id, ts),
  ])
  const old = before!.results[0] as MessageRow | undefined
  if (!update!.meta.changes) throw refusal(old, app.id, body)
  const row = after!.results[0] as MessageRow
  const extras = knownExtras(reactions!.results as ReactionRow[], [app])
  // Task and plan updates alone change nothing here: no event for them.
  const changed = row.text !== old!.text || row.blocks !== old!.blocks || row.stream_state !== old!.stream_state
  const message = changed
    ? announceChanged(ctx, c, { before: old!, after: row, audience: audienceFrom(audience!), extras })
    : messageJson(row, extras, ctx.origin)
  return { c, after: row, message }
}

/** Why a guarded change to a stream changed nothing, from the row it found. */
function refusal(row: MessageRow | undefined, appId: string, body: Content): CampflareError {
  if (!row) return new CampflareError("message_not_found")
  if (row.app_id !== appId) return new CampflareError("message_not_owned_by_app")
  if (row.stream_state !== "in_progress") return new CampflareError("message_not_in_streaming_state")
  if (body.mode && row.stream_mode && row.stream_mode !== body.mode)
    return new CampflareError("streaming_mode_mismatch")
  if (row.text.length + body.markdown.length > MAX_TEXT) return new CampflareError("msg_too_long")
  return new CampflareError("msg_blocks_too_many")
}
