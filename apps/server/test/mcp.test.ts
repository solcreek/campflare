import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client"
import { SELF } from "cloudflare:test"
import { describe, expect, it } from "vitest"
import { ORIGIN, ok, workspace } from "./helpers"
import { makePng } from "./images"

const MCP_URL = "https://campflare.test/mcp"

/** The official client, talking to the Worker in-process. Modern (2026-07-28) unless asked for the 2025 handshake. */
async function connect(token: string, { legacy = false } = {}) {
  const client = new Client(
    { name: "campflare-test", version: "1.0.0" },
    legacy ? {} : { versionNegotiation: { mode: { pin: "2026-07-28" } } },
  )
  const transport = new StreamableHTTPClientTransport(new URL(MCP_URL), {
    fetch: (input, init) => SELF.fetch(new Request(input, init)),
    requestInit: { headers: { authorization: `Bearer ${token}` } },
  })
  await client.connect(transport)
  return client
}

type ToolResult = {
  structuredContent?: Record<string, unknown>
  isError?: boolean
  content: { type: string; text?: string }[]
}

async function callTool<T = Record<string, unknown>>(client: Client, name: string, args: Record<string, unknown> = {}) {
  const res = (await client.callTool({ name, arguments: args })) as ToolResult
  if (res.isError) throw new Error(`${name}: ${res.content.map((c) => c.text).join(" ")}`)
  return res.structuredContent as T
}

describe("MCP over Streamable HTTP", () => {
  it("refuses requests without a valid user or bot token", async () => {
    const w = await workspace()
    const app = await w.addApp("Robot")
    const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" })
    const post = (headers: Record<string, string>) =>
      SELF.fetch(MCP_URL, { method: "POST", headers: { "content-type": "application/json", ...headers }, body })
    const missing = await post({})
    expect(missing.status).toBe(401)
    expect(missing.headers.get("www-authenticate")).toMatch(/^Bearer/)
    expect((await post({ authorization: "Bearer xoxp-nope" })).status).toBe(401)
    expect((await post({ authorization: `Bearer ${app.appToken}` })).status).toBe(401)
    // A browser page from another origin can't drive it (DNS rebinding).
    expect((await post({ authorization: `Bearer ${w.owner.token}`, origin: "https://evil.example" })).status).toBe(403)
  })

  it("speaks the 2026-07-28 protocol and lists Campflare's tools", async () => {
    const w = await workspace()
    const client = await connect(w.owner.token)
    const { tools } = await client.listTools()
    expect(tools.map((t) => t.name).toSorted()).toEqual([
      "add_reaction",
      "cancel_scheduled",
      "get_activity",
      "get_events",
      "list_conversations",
      "list_emoji",
      "list_groups",
      "list_people",
      "list_pins",
      "list_saved",
      "list_scheduled",
      "mark_activity_read",
      "read_messages",
      "read_thread",
      "schedule_message",
      "search_messages",
      "send_message",
      "set_reminder",
      "wait_for_reply",
      "whoami",
    ])
    expect(tools.find((t) => t.name === "read_messages")?.annotations).toMatchObject({ readOnlyHint: true })
    expect(tools.find((t) => t.name === "send_message")?.annotations).toMatchObject({ readOnlyHint: false })
    expect(await callTool(client, "whoami")).toMatchObject({ user: "@owner", user_id: w.owner.id, token: "user" })
    await client.close()
  })

  it("still serves 2025-era clients through the initialize handshake", async () => {
    const w = await workspace()
    const client = await connect(w.owner.token, { legacy: true })
    expect(client.getServerVersion()).toMatchObject({ name: "campflare" })
    expect(client.getInstructions()).toContain("Campflare")
    expect(await callTool(client, "whoami")).toMatchObject({ user: "@owner" })
    await client.close()
  })

  it("sends, reads, threads, reacts and searches", async () => {
    const w = await workspace()
    const bob = await w.addUser("bob")
    const client = await connect(w.owner.token)
    const sent = await callTool<{ conversation: string; ts: string; permalink: string }>(client, "send_message", {
      conversation: "#general",
      text: "Hello from an agent",
    })
    expect(sent.conversation).toBe(w.general)
    expect(sent.permalink).toContain(`/archives/${w.general}/p`)
    await ok("chat.postMessage", { channel: w.general, text: "a reply", thread_ts: sent.ts }, bob.token)
    await callTool(client, "send_message", { conversation: "#general", text: "and another", thread_ts: sent.ts })
    expect(await callTool(client, "add_reaction", { conversation: "#general", ts: sent.ts, emoji: "eyes" })).toEqual({
      ok: true,
    })
    // Reacting twice is fine: the tool is idempotent.
    await callTool(client, "add_reaction", { conversation: "#general", ts: sent.ts, emoji: "eyes" })

    const read = await callTool<{ messages: Record<string, unknown>[]; last_read?: string }>(client, "read_messages", {
      conversation: "#general",
    })
    expect(read.last_read).toBe("0000000000.000000") // a member who hasn't marked anything read
    expect(read.messages.at(-1)).toMatchObject({
      ts: sent.ts,
      from: "@owner",
      text: "Hello from an agent",
      replies: 2,
      reactions: [":eyes: 1"],
    })
    const thread = await callTool<{ messages: Record<string, unknown>[] }>(client, "read_thread", {
      conversation: w.general,
      ts: sent.ts,
    })
    expect(thread.messages.map((m) => [m.from, m.text])).toEqual([
      ["@owner", "Hello from an agent"],
      ["@bob", "a reply"],
      ["@owner", "and another"],
    ])
    const found = await callTool<{ total: number; matches: Record<string, unknown>[] }>(client, "search_messages", {
      query: "agent in:#general",
    })
    expect(found.total).toBe(1)
    expect(found.matches[0]).toMatchObject({ conversation: w.general, conversation_name: "#general", from: "@owner" })
    await client.close()
  })

  it("lists what's pinned in a conversation and what you saved", async () => {
    const w = await workspace()
    const bob = await w.addUser("bob")
    const client = await connect(w.owner.token)
    const { ts } = await ok<{ ts: string }>(
      "chat.postMessage",
      { channel: w.general, text: "Decisión: lanzamos el lunes · 周一发布" },
      bob.token,
    )
    await ok("pins.add", { channel: w.general, timestamp: ts }, bob.token)
    const pins = await callTool<{ pins: Record<string, unknown>[] }>(client, "list_pins", { conversation: "#general" })
    expect(pins.pins).toEqual([
      expect.objectContaining({ ts, from: "@bob", pinned: true, pinned_by: "@bob", permalink: expect.any(String) }),
    ])
    expect(await callTool(client, "list_saved")).toEqual({ total: 0, items: [] })
    await ok("stars.add", { channel: w.general, timestamp: ts }, w.owner.token)
    await ok("stars.add", { channel: w.general }, w.owner.token)
    const saved = await callTool<{ total: number; items: Record<string, unknown>[] }>(client, "list_saved")
    expect(saved.total).toBe(2)
    expect(saved.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "message", conversation: w.general, ts, from: "@bob" }),
        { type: "conversation", conversation: w.general },
      ]),
    )
    await client.close()
  })

  it("names DMs by @handle and lists conversations and people", async () => {
    const w = await workspace()
    const bob = await w.addUser("bob", { real_name: "Bob Builder" })
    const client = await connect(w.owner.token)
    const sent = await callTool<{ conversation: string }>(client, "send_message", {
      conversation: "@bob",
      text: "psst",
    })
    expect(sent.conversation).toMatch(/^D/)
    const convos = await callTool<{ conversations: Record<string, unknown>[] }>(client, "list_conversations")
    expect(convos.conversations).toContainEqual({ id: w.general, name: "#general", kind: "channel" })
    expect(convos.conversations).toContainEqual({ id: sent.conversation, name: "@bob", kind: "dm" })
    const dms = await callTool<{ conversations: unknown[] }>(client, "list_conversations", { kinds: ["dm"] })
    expect(dms.conversations).toHaveLength(1)
    const people = await callTool<{ people: Record<string, unknown>[] }>(client, "list_people", { query: "builder" })
    expect(people.people).toEqual([{ id: expect.any(String), handle: "@bob", name: "Bob Builder" }])
    const { usergroup } = await ok<{ usergroup: { id: string } }>(
      "usergroups.create",
      { name: "Équipe 建設", handle: "builders", description: "Obras · 공사" },
      w.owner.token,
    )
    await ok("usergroups.users.update", { usergroup: usergroup.id, users: bob.id }, w.owner.token)
    await ok("usergroups.create", { name: "Plain", handle: "plain" }, w.owner.token)
    const groups = await callTool<{ groups: Record<string, unknown>[] }>(client, "list_groups")
    expect(groups.groups).toEqual(
      expect.arrayContaining([
        {
          id: usergroup.id,
          handle: "@builders",
          name: "Équipe 建設",
          description: "Obras · 공사",
          mention: `<!subteam^${usergroup.id}|@builders>`,
          members: ["@bob"],
        },
        { id: expect.any(String), handle: "@plain", name: "Plain", mention: expect.any(String), members: [] },
      ]),
    )
    expect(groups.groups).toHaveLength(2)
    await client.close()
  })

  it("lists custom emoji and their aliases", async () => {
    const w = await workspace()
    const client = await connect(w.owner.token)
    expect(await callTool(client, "list_emoji")).toEqual({ emoji: [] })
    const form = new FormData()
    form.set("name", "shipit")
    form.set("image", new File([await makePng(16, 16)], "shipit.png"))
    const added = (await (
      await SELF.fetch(`${ORIGIN}/api/campflare.emoji.add`, {
        method: "POST",
        headers: { authorization: `Bearer ${w.owner.token}` },
        body: form,
      })
    ).json()) as { emoji: { url: string } }
    await ok("admin.emoji.addAlias", { name: "lgtm", alias_for: "shipit" }, w.owner.token)
    expect(await callTool(client, "list_emoji")).toEqual({
      emoji: [
        { name: "lgtm", alias_for: "shipit" },
        { name: "shipit", url: added.emoji.url },
      ],
    })
    await client.close()
  })

  it("schedules a message and sets a reminder, at times as people say them", async () => {
    const w = await workspace()
    const client = await connect(w.owner.token)
    const before = Date.now()
    const scheduled = await callTool<{ conversation: string; scheduled_message_id: string; post_at: string }>(
      client,
      "schedule_message",
      { conversation: "#general", text: "Rappel : réunion, 회의, 会议", at: "in 2 hours" },
    )
    expect(scheduled.conversation).toBe(w.general)
    expect(Date.parse(scheduled.post_at) - before).toBeGreaterThanOrEqual(7_199_000)
    type Scheduled = {
      scheduled: { scheduled_message_id: string; conversation: string; post_at: string; text: string }[]
    }
    const listed = await callTool<Scheduled>(client, "list_scheduled", { conversation: "#general" })
    expect(listed.scheduled).toEqual([
      {
        scheduled_message_id: scheduled.scheduled_message_id,
        conversation: w.general,
        post_at: scheduled.post_at,
        text: "Rappel : réunion, 회의, 会议",
      },
    ])
    expect(
      await callTool(client, "cancel_scheduled", {
        conversation: "#general",
        scheduled_message_id: scheduled.scheduled_message_id,
      }),
    ).toEqual({ cancelled: true, scheduled_message_id: scheduled.scheduled_message_id })
    expect((await callTool<Scheduled>(client, "list_scheduled")).scheduled).toEqual([])
    const again = (await client.callTool({
      name: "cancel_scheduled",
      arguments: { conversation: "#general", scheduled_message_id: scheduled.scheduled_message_id },
    })) as ToolResult
    expect(again).toMatchObject({ isError: true, content: [{ text: "error: invalid_scheduled_message_id" }] })

    const reminder = await callTool<{ reminder_id: string; at: string }>(client, "set_reminder", {
      text: "Stand-up",
      at: "2h",
    })
    expect(reminder.reminder_id).toMatch(/^Rm/)
    const bad = (await client.callTool({
      name: "set_reminder",
      arguments: { text: "x", at: "whenever" },
    })) as ToolResult
    expect(bad).toMatchObject({ isError: true, content: [{ text: "error: cannot_parse" }] })
    await client.close()
  })

  it("returns API errors as tool errors the model can read", async () => {
    const w = await workspace()
    const client = await connect(w.owner.token)
    const res = (await client.callTool({
      name: "read_messages",
      arguments: { conversation: "#nowhere" },
    })) as ToolResult
    expect(res.isError).toBe(true)
    expect(res.content[0]!.text).toBe("error: channel_not_found")
    const nobody = (await client.callTool({
      name: "send_message",
      arguments: { conversation: "@nobody", text: "x" },
    })) as ToolResult
    expect(nobody.content[0]!.text).toBe("error: user_not_found")
    await client.close()
  })

  it("tells an agent what needs its attention, and marks it handled", async () => {
    const w = await workspace()
    const bob = await w.addUser("bob")
    const client = await connect(w.owner.token)
    const { ts } = await ok<{ ts: string }>(
      "chat.postMessage",
      { channel: w.general, text: `<@${w.owner.id}> ¿puedes revisar? 请看一下` },
      bob.token,
    )
    await ok("reactions.add", { channel: w.general, timestamp: ts, name: "eyes" }, w.owner.token)
    const mine = await ok<{ ts: string }>("chat.postMessage", { channel: w.general, text: "Bericht" }, w.owner.token)
    await ok("reactions.add", { channel: w.general, timestamp: mine.ts, name: "heart" }, bob.token)

    const activity = await callTool<{ unread: Record<string, number>; items: Record<string, unknown>[] }>(
      client,
      "get_activity",
    )
    expect(activity.unread).toMatchObject({ total: 2, mention: 1, reaction: 1 })
    expect(activity.items).toEqual([
      expect.objectContaining({ type: "reaction", emoji: "heart", by: "@bob", ts: mine.ts }),
      expect.objectContaining({
        type: "mention",
        conversation: w.general,
        by: "@bob",
        message: expect.objectContaining({ from: "@bob", text: expect.stringContaining("请看") }),
      }),
    ])
    const mentions = await callTool<{ items: { id: string }[] }>(client, "get_activity", { types: ["mention"] })
    expect(await callTool(client, "mark_activity_read", { ids: [mentions.items[0]!.id] })).toMatchObject({
      marked: 1,
      unread: { total: 1 },
    })
    const all = await callTool<{ items: Record<string, unknown>[] }>(client, "get_activity", { unread_only: false })
    expect(all.items.map((i) => i.read ?? false)).toEqual([false, true])
    for (const args of [{}, { ids: [] }, { all: false }]) {
      const res = (await client.callTool({ name: "mark_activity_read", arguments: args })) as ToolResult
      expect(res.isError).toBe(true)
      expect(res.content[0]!.text).toBe(
        "error: invalid_arguments\n[ERROR] give ids (the items' ids from get_activity) or all: true",
      )
    }
    expect(await callTool(client, "mark_activity_read", { all: true })).toMatchObject({ unread: { total: 0 } })
    expect((await callTool<{ items: unknown[] }>(client, "get_activity")).items).toEqual([])
    await client.close()
  })

  it("follows events from a cursor", async () => {
    const w = await workspace()
    const client = await connect(w.owner.token)
    const { cursor } = await callTool<{ cursor: string }>(client, "get_events")
    const sent = await callTool<{ ts: string }>(client, "send_message", { conversation: "#general", text: "event!" })
    await ok("reactions.add", { channel: w.general, timestamp: sent.ts, name: "tada" }, w.owner.token)
    await ok("chat.update", { channel: w.general, ts: sent.ts, text: "event, edited" }, w.owner.token)
    await ok("conversations.join", { channel: w.general }, w.owner.token)
    const seen: Record<string, unknown>[] = []
    let next = cursor
    for (let i = 0; i < 10 && !seen.some((e) => e.change === "edited"); i++) {
      const page = await callTool<{ events: Record<string, unknown>[]; cursor: string }>(client, "get_events", {
        cursor: next,
        wait_seconds: 1,
      })
      seen.push(...page.events)
      next = page.cursor
    }
    expect(seen).toContainEqual({
      type: "message",
      conversation: w.general,
      ts: sent.ts,
      from: "@owner",
      text: "event!",
    })
    expect(seen).toContainEqual({
      type: "reaction_added",
      conversation: w.general,
      ts: sent.ts,
      emoji: "tada",
      by: "@owner",
    })
    expect(seen).toContainEqual({
      type: "message",
      conversation: w.general,
      change: "edited",
      ts: sent.ts,
      text: "event, edited",
    })
    await client.close()
  })

  it("waits for someone else's reply in a thread", { timeout: 15_000 }, async () => {
    const w = await workspace()
    const bob = await w.addUser("bob")
    const client = await connect(w.owner.token)
    const asked = await callTool<{ ts: string }>(client, "send_message", { conversation: "#general", text: "Ship it?" })
    const waiting = callTool<{ replied: boolean; message: Record<string, unknown> }>(client, "wait_for_reply", {
      conversation: "#general",
      thread_ts: asked.ts,
      from: "@bob",
      timeout_seconds: 10,
    })
    await new Promise((r) => setTimeout(r, 200))
    // Noise the wait must skip: own messages, other channels' and off-thread messages.
    await callTool(client, "send_message", { conversation: "#general", text: "self", thread_ts: asked.ts })
    await ok("chat.postMessage", { channel: w.general, text: "not in the thread" }, bob.token)
    await ok("chat.postMessage", { channel: w.general, text: "Yes, ship it", thread_ts: asked.ts }, bob.token)
    const reply = await waiting
    expect(reply).toMatchObject({ replied: true, message: { from: "@bob", text: "Yes, ship it", thread_ts: asked.ts } })
    await client.close()
  })

  it("gives up waiting at the timeout", async () => {
    const w = await workspace()
    const client = await connect(w.owner.token)
    const res = await callTool(client, "wait_for_reply", { conversation: "#general", timeout_seconds: 1 })
    expect(res).toEqual({ replied: false, conversation: w.general })
    await client.close()
  })

  it("works with a bot token, as the bot", async () => {
    const w = await workspace()
    const app = await w.addApp("Deploy Bot")
    const client = await connect(app.botToken)
    expect(await callTool(client, "whoami")).toMatchObject({ user_id: app.botUserId, token: "bot" })
    const sent = await callTool<{ ts: string }>(client, "send_message", { conversation: "#general", text: "deployed" })
    const history = await ok<{ messages: { ts: string; bot_id?: string }[] }>(
      "conversations.history",
      { channel: w.general },
      w.owner.token,
    )
    expect(history.messages.find((m) => m.ts === sent.ts)?.bot_id).toBe(app.botId)
    // Search needs a user token: the tool says so instead of failing the call.
    const res = (await client.callTool({ name: "search_messages", arguments: { query: "x" } })) as ToolResult
    expect(res).toMatchObject({ isError: true, content: [{ text: "error: not_allowed_token_type" }] })
    await client.close()
  })

  it("describes bots, files, edits, deletions and joins compactly", async () => {
    const w = await workspace()
    const app = await w.addApp("CI Bot")
    const client = await connect(w.owner.token)
    const { cursor } = await callTool<{ cursor: string }>(client, "get_events")
    await ok("chat.postMessage", { channel: w.general, text: "build passed" }, app.botToken)
    await ok("chat.postMessage", { channel: w.general, text: "custom", username: "Release Bot" }, app.botToken)
    const reserved = await ok<{ upload_url: string; file_id: string }>(
      "files.getUploadURLExternal",
      { filename: "log.txt", length: 2 },
      w.owner.token,
    )
    await SELF.fetch(reserved.upload_url, { method: "POST", body: "ok" })
    await ok(
      "files.completeUploadExternal",
      { files: [{ id: reserved.file_id }], channel_id: w.general },
      w.owner.token,
    )
    const doomed = await ok<{ ts: string }>("chat.postMessage", { channel: w.general, text: "oops" }, w.owner.token)
    await ok("chat.update", { channel: w.general, ts: doomed.ts, text: "oops, fixed" }, w.owner.token)
    const read = await callTool<{ messages: Record<string, unknown>[] }>(client, "read_messages", {
      conversation: "#general",
      limit: 4,
    })
    expect(read.messages.map((m) => m.from)).toEqual(["CI Bot", "Release Bot", "@owner", "@owner"])
    expect(read.messages[2]).toMatchObject({ files: ["log.txt"] })
    expect(read.messages[3]).toMatchObject({ text: "oops, fixed", edited: true })
    await ok("chat.delete", { channel: w.general, ts: doomed.ts }, w.owner.token)
    await ok("conversations.create", { name: "ops" }, w.owner.token)

    const seen: Record<string, unknown>[] = []
    let next = cursor
    for (let i = 0; i < 10 && !seen.some((e) => e.type === "channel_created"); i++) {
      const page = await callTool<{ events: Record<string, unknown>[]; cursor: string }>(client, "get_events", {
        cursor: next,
        wait_seconds: 1,
      })
      seen.push(...page.events)
      next = page.cursor
    }
    expect(seen).toContainEqual({ type: "message", conversation: w.general, change: "deleted", ts: doomed.ts })
    expect(seen).toContainEqual(expect.objectContaining({ type: "message", from: "CI Bot", text: "build passed" }))
    expect(seen).toContainEqual({ type: "file_shared", conversation: w.general, user: "@owner" })
    expect(seen).toContainEqual({ type: "channel_created" })

    // "@me" is your own DM; `before` pages back through history.
    const self = await callTool<{ conversation: string }>(client, "send_message", { conversation: "@me", text: "note" })
    const older = await callTool<{ messages: unknown[] }>(client, "read_messages", {
      conversation: "#general",
      before: doomed.ts,
    })
    expect(older.messages.length).toBeGreaterThan(0)
    expect(self.conversation).toMatch(/^D/)
    await client.close()
  })
})
