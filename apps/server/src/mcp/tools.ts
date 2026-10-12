import { McpServer } from "@modelcontextprotocol/server"
import * as z from "zod"
import { CampflareError } from "../api/errors"
import { author, compactMessage, directory, result, type Directory, type RawMessage } from "./format"
import { invoke, type Caller } from "./invoke"
import { conversationId, userIdOf } from "./resolve"

const INSTRUCTIONS = `Campflare is a team chat workspace (Slack-compatible). You act as the user who owns the token.
Conversations can be named "#channel", "@handle" (your DM with that person) or by id (C…, D…, G…).
Messages are identified by their conversation and "ts"; a thread is its first message's ts.
Use get_events or wait_for_reply to see what happens next instead of re-reading history in a loop.`

const conversation = z.string().min(1).describe('"#channel", "@handle" for a direct message, or a conversation id')

const READ = { readOnlyHint: true, openWorldHint: false } as const
const WRITE = { readOnlyHint: false, destructiveHint: false, openWorldHint: false } as const

type Handler<A> = (args: A) => Promise<Record<string, unknown>>

/** Runs a tool body, turning API errors into tool errors the model can read and act on. */
function tool<A>(fn: Handler<A>) {
  return async (args: A) => {
    try {
      return result(await fn(args))
    } catch (error) {
      if (!(error instanceof CampflareError)) throw error
      const detail = (error.extra.response_metadata as { messages?: string[] } | undefined)?.messages ?? []
      return {
        isError: true,
        content: [{ type: "text" as const, text: [`error: ${error.code}`, ...detail].join("\n") }],
      }
    }
  }
}

const KINDS = { channel: "public_channel", private: "private_channel", dm: "im", group: "mpim" } as const

export function buildServer(caller: Caller): McpServer {
  const server = new McpServer({ name: "campflare", version: "0.1.0" }, { instructions: INSTRUCTIONS })

  server.registerTool(
    "whoami",
    { title: "Who am I", description: "The user and workspace this connection acts as.", annotations: READ },
    tool(async () => {
      const { user, team, kind } = caller.auth
      return { user: `@${user.name}`, user_id: user.id, workspace: team.name, workspace_id: team.id, token: kind }
    }),
  )

  server.registerTool(
    "list_conversations",
    {
      title: "List conversations",
      description: "The conversations you are in, with unread counts where known.",
      inputSchema: z.object({
        kinds: z
          .array(z.enum(["channel", "private", "dm", "group"]))
          .optional()
          .describe("Which kinds to list (default: all)"),
      }),
      annotations: READ,
    },
    tool(async ({ kinds }) => {
      const types = (kinds?.length ? kinds : (["channel", "private", "dm", "group"] as const)).map((k) => KINDS[k])
      const res = await invoke<{ channels: Record<string, unknown>[] }>(caller, "users.conversations", {
        types: types.join(","),
        exclude_archived: true,
        limit: 999,
      })
      const dir = await directory(caller)
      return {
        conversations: res.channels.map((c) => ({
          id: c.id,
          name: c.is_im ? dir.name(c.user as string) : c.is_mpim ? c.name : `#${String(c.name)}`,
          kind: c.is_im ? "dm" : c.is_mpim ? "group" : c.is_private ? "private" : "channel",
        })),
      }
    }),
  )

  server.registerTool(
    "read_messages",
    {
      title: "Read messages",
      description:
        "Recent messages in a conversation, oldest first. Thread replies are not included: use read_thread for those.",
      inputSchema: z.object({
        conversation,
        limit: z.number().int().min(1).max(200).default(20),
        before: z.string().optional().describe("Only messages older than this ts, to page back"),
      }),
      annotations: READ,
    },
    tool(async ({ conversation: ref, limit, before }) => {
      const channel = await conversationId(caller, ref)
      const res = await invoke<{ messages: RawMessage[]; has_more: boolean }>(caller, "conversations.history", {
        channel,
        limit,
        latest: before,
      })
      const dir = await directory(caller)
      const info = await invoke<{ channel: { last_read?: string; unread_count?: number } }>(
        caller,
        "conversations.info",
        {
          channel,
        },
      )
      return {
        conversation: channel,
        messages: res.messages.toReversed().map((m) => compactMessage(m, dir)),
        has_more: res.has_more,
        ...(info.channel.last_read ? { last_read: info.channel.last_read } : {}),
      }
    }),
  )

  server.registerTool(
    "read_thread",
    {
      title: "Read a thread",
      description: "A thread: its first message and every reply, oldest first.",
      inputSchema: z.object({ conversation, ts: z.string().describe("The ts of the thread's first message") }),
      annotations: READ,
    },
    tool(async ({ conversation: ref, ts }) => {
      const channel = await conversationId(caller, ref)
      const res = await invoke<{ messages: RawMessage[] }>(caller, "conversations.replies", { channel, ts })
      const dir = await directory(caller)
      return { conversation: channel, messages: res.messages.map((m) => compactMessage(m, dir)) }
    }),
  )

  server.registerTool(
    "search_messages",
    {
      title: "Search messages",
      description:
        'Search messages you can read. Supports words, "exact phrases", -exclusions, in:#channel, in:@person, from:@person, before:/after:/on: YYYY-MM-DD, has:link, has:reaction, has:file, is:thread.',
      inputSchema: z.object({
        query: z.string().min(1),
        limit: z.number().int().min(1).max(100).default(20),
        newest_first: z.boolean().default(false).describe("Sort by time instead of relevance"),
      }),
      annotations: READ,
    },
    tool(async ({ query, limit, newest_first }) => {
      const res = await invoke<{
        messages: {
          total: number
          matches: (RawMessage & { channel: { id: string; name: string; is_im: boolean }; permalink: string })[]
        }
      }>(caller, "search.messages", { query, count: limit, sort: newest_first ? "timestamp" : "score" })
      const dir = await directory(caller)
      return {
        total: res.messages.total,
        matches: res.messages.matches.map((m) => ({
          conversation: m.channel.id,
          conversation_name: m.channel.is_im ? dir.name(m.channel.name) : `#${m.channel.name}`,
          ...compactMessage(m, dir),
        })),
      }
    }),
  )

  server.registerTool(
    "list_people",
    {
      title: "List people",
      description: "People (and bots) in the workspace, optionally filtered by a name fragment.",
      inputSchema: z.object({ query: z.string().optional() }),
      annotations: READ,
    },
    tool(async ({ query }) => {
      const res = await invoke<{
        members: {
          id: string
          name: string
          real_name: string
          is_bot: boolean
          deleted: boolean
          profile: { display_name: string; title: string }
        }[]
      }>(caller, "users.list", { limit: 1000 })
      const q = query?.toLowerCase()
      const people = res.members
        .filter((u) => !u.deleted)
        .filter((u) => !q || [u.name, u.real_name, u.profile.display_name].some((n) => n.toLowerCase().includes(q)))
        .map((u) => ({
          id: u.id,
          handle: `@${u.name}`,
          name: u.real_name,
          ...(u.profile.title ? { title: u.profile.title } : {}),
          ...(u.is_bot ? { bot: true } : {}),
        }))
      return { people }
    }),
  )

  server.registerTool(
    "send_message",
    {
      title: "Send a message",
      description: "Post a message (Slack mrkdwn) to a conversation, or reply in a thread.",
      inputSchema: z.object({
        conversation,
        text: z.string().min(1).max(40_000),
        thread_ts: z.string().optional().describe("Reply in this thread"),
        broadcast: z.boolean().default(false).describe("Also show a thread reply in the conversation"),
      }),
      annotations: WRITE,
    },
    tool(async ({ conversation: ref, text, thread_ts, broadcast }) => {
      const channel = await conversationId(caller, ref)
      const res = await invoke<{ channel: string; ts: string }>(caller, "chat.postMessage", {
        channel,
        text,
        thread_ts,
        reply_broadcast: broadcast,
      })
      const link = await invoke<{ permalink: string }>(caller, "chat.getPermalink", { channel, message_ts: res.ts })
      return { conversation: res.channel, ts: res.ts, permalink: link.permalink }
    }),
  )

  server.registerTool(
    "add_reaction",
    {
      title: "React to a message",
      description: "Add an emoji reaction to a message.",
      inputSchema: z.object({
        conversation,
        ts: z.string(),
        emoji: z.string().describe('An emoji name, e.g. "eyes" or "white_check_mark"'),
      }),
      annotations: { ...WRITE, idempotentHint: true },
    },
    tool(async ({ conversation: ref, ts, emoji }) => {
      const channel = await conversationId(caller, ref)
      try {
        await invoke(caller, "reactions.add", { channel, timestamp: ts, name: emoji })
      } catch (error) {
        if (!(error instanceof CampflareError && error.code === "already_reacted")) throw error
      }
      return { ok: true }
    }),
  )

  server.registerTool(
    "get_events",
    {
      title: "Get events",
      description:
        "What happened since a cursor (messages, edits, reactions, joins…), in order. Call without a cursor to get the current one, then pass back the cursor each call returns. Waits up to wait_seconds for something new.",
      inputSchema: z.object({
        cursor: z.string().optional(),
        wait_seconds: z.number().int().min(0).max(30).default(0),
      }),
      annotations: READ,
    },
    tool(async ({ cursor, wait_seconds }) => {
      const res = await invoke<{
        events: { cursor: string; event: Record<string, unknown> }[]
        cursor: string
        has_more: boolean
      }>(caller, "campflare.events.poll", { cursor, wait: wait_seconds })
      const dir = await directory(caller)
      return {
        events: res.events.map(({ event }) => summarizeEvent(event, dir)),
        cursor: res.cursor,
        has_more: res.has_more,
      }
    }),
  )

  server.registerTool(
    "wait_for_reply",
    {
      title: "Wait for a reply",
      description:
        "Wait for someone else's next message in a conversation (or one thread of it), and return it. Use after asking a person a question.",
      inputSchema: z.object({
        conversation,
        thread_ts: z.string().optional().describe("Only replies in this thread"),
        from: z.string().optional().describe('Only messages from this person ("@handle")'),
        timeout_seconds: z.number().int().min(1).max(55).default(50),
      }),
      annotations: READ,
    },
    tool(async ({ conversation: ref, thread_ts, from, timeout_seconds }) => {
      const channel = await conversationId(caller, ref)
      const sender = from ? await userIdOf(caller, from) : undefined
      const deadline = Date.now() + timeout_seconds * 1000
      let { cursor } = await invoke<{ cursor: string }>(caller, "campflare.events.poll")
      const dir = await directory(caller)
      while (Date.now() < deadline) {
        const wait = Math.min(30, Math.max(1, Math.floor((deadline - Date.now()) / 1000)))
        const page = await invoke<{
          events: { event: RawMessage & { type: string; channel?: string } }[]
          cursor: string
        }>(caller, "campflare.events.poll", { cursor, wait })
        cursor = page.cursor
        const reply = page.events
          .map((e) => e.event)
          .find(
            (e) =>
              e.type === "message" &&
              e.channel === channel &&
              (!e.subtype || e.subtype === "thread_broadcast" || e.subtype === "file_share") &&
              e.user !== caller.auth.user.id &&
              (!sender || e.user === sender) &&
              (!thread_ts || e.thread_ts === thread_ts),
          )
        if (reply) return { replied: true, conversation: channel, message: compactMessage(reply, dir) }
      }
      return { replied: false, conversation: channel }
    }),
  )

  return server
}

/** One line of what an event means, plus the ids to act on it. */
function summarizeEvent(e: Record<string, unknown>, dir: Directory) {
  const type = String(e.type)
  // Events name their conversation and person in different fields (channel or channel_id, user or user_id).
  const where = typeof e.channel === "string" ? e.channel : typeof e.channel_id === "string" ? e.channel_id : undefined
  const base = { type, ...(where ? { conversation: where } : {}) }
  if (type === "message") {
    const m = e as unknown as RawMessage & { subtype?: string; message?: RawMessage; deleted_ts?: string }
    if (m.subtype === "message_changed" && m.message)
      return { ...base, change: "edited", ts: m.message.ts, text: m.message.text }
    if (m.subtype === "message_deleted") return { ...base, change: "deleted", ts: m.deleted_ts }
    return {
      ...base,
      ts: m.ts,
      from: author(m, dir),
      text: m.text ?? "",
      ...(m.subtype ? { subtype: m.subtype } : {}),
      ...(m.thread_ts && m.thread_ts !== m.ts ? { thread_ts: m.thread_ts } : {}),
    }
  }
  if (type === "reaction_added" || type === "reaction_removed") {
    const item = e.item as { channel?: string; ts?: string }
    return { type, conversation: item.channel, ts: item.ts, emoji: e.reaction, by: dir.name(e.user as string) }
  }
  const user = typeof e.user === "string" ? e.user : typeof e.user_id === "string" ? e.user_id : undefined
  if (user) return { ...base, user: dir.name(user) }
  return base
}
