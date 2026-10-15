import { SELF } from "cloudflare:test"
import { env } from "cloudflare:workers"
import { describe, expect, it } from "vitest"
import "../src/index"
import { issueToken } from "../src/api/auth"
import { methods } from "../src/api/context"
import { acceptedScopes, DEFAULT_BOT_SCOPES, FULL_USER_SCOPES, NEEDS, PRESETS } from "../src/api/scopes"
import { call, expectError, ok, ORIGIN, workspace } from "./helpers"

/** A user token holding only these scopes, as a person would mint for an agent. */
const narrow = (teamId: string, userId: string, scopes: string[]) =>
  issueToken(env, { teamId, kind: "user", userId, scopes, label: "narrow" })

describe("the scope table", () => {
  it("covers every method, and only methods that exist", () => {
    const registered = [...methods.keys()].toSorted()
    expect(registered.filter((m) => !(m in NEEDS))).toEqual([])
    expect(Object.keys(NEEDS).filter((m) => !methods.has(m))).toEqual([])
  })

  it("asks a scope of every method that takes a token, except Slack's few that need none", () => {
    const none = [...methods]
      .filter(([name, def]) => def.access !== "none" && acceptedScopes(NEEDS[name]!).length === 0)
      .map(([name]) => name)
      .toSorted()
    expect(none).toEqual([
      "auth.revoke",
      "auth.test",
      "chat.getPermalink",
      "views.open",
      "views.push",
      "views.update",
    ])
  })
})

describe("missing_scope", () => {
  it("answers what would do and what the token has, as Slack does, with the scope headers", async () => {
    const w = await workspace()
    const token = await narrow(w.teamId, w.owner.id, ["channels:read"])
    const res = await SELF.fetch(
      new Request(`${ORIGIN}/api/chat.postMessage`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
        body: new URLSearchParams({ channel: w.general, text: "hola" }),
      }),
    )
    expect(await res.json()).toEqual({
      ok: false,
      error: "missing_scope",
      needed: "chat:write",
      provided: "channels:read",
    })
    expect(res.headers.get("x-oauth-scopes")).toBe("channels:read")
    expect(res.headers.get("x-accepted-oauth-scopes")).toBe("chat:write")
  })

  it("lets through what the token holds", async () => {
    const w = await workspace()
    const token = await narrow(w.teamId, w.owner.id, ["chat:write"])
    await ok("chat.postMessage", { channel: w.general, text: "Grüße, 你好, 안녕" }, token)
    await expectError(
      "reactions.add",
      { channel: w.general, name: "tada", timestamp: "1.000001" },
      token,
      "missing_scope",
    )
  })

  it("checks a conversation method against the conversation's type", async () => {
    const w = await workspace()
    const secret = (
      await ok<{ channel: { id: string } }>(
        "conversations.create",
        { name: "secreto", is_private: true },
        w.owner.token,
      )
    ).channel.id
    const token = await narrow(w.teamId, w.owner.id, ["channels:history"])
    await ok("conversations.history", { channel: w.general }, token)
    expect(await call("conversations.history", { channel: secret }, token)).toMatchObject({
      error: "missing_scope",
      needed: "groups:history",
    })
  })

  it("never reveals a private conversation the caller isn't in", async () => {
    const w = await workspace()
    const bob = await w.addUser("bob")
    const hidden = (
      await ok<{ channel: { id: string } }>("conversations.create", { name: "geheim", is_private: true }, w.owner.token)
    ).channel.id
    const token = await narrow(w.teamId, bob.id, ["channels:history"])
    await expectError("conversations.history", { channel: hidden }, token, "channel_not_found")
  })

  it("wants the up-front scope for some type before looking anything up", async () => {
    const w = await workspace()
    const token = await narrow(w.teamId, w.owner.id, ["chat:write"])
    expect(await call("conversations.history", { channel: "CNOPE" }, token)).toMatchObject({
      error: "missing_scope",
      needed: "channels:history,groups:history,im:history,mpim:history",
    })
  })

  it("lists only the conversation types the token can read", async () => {
    const w = await workspace()
    const token = await narrow(w.teamId, w.owner.id, ["channels:read"])
    const list = await ok<{ channels: { id: string }[] }>("conversations.list", {}, token)
    expect(list.channels.map((c) => c.id)).toContain(w.general)
    expect(await call("conversations.list", { types: "public_channel,im" }, token)).toMatchObject({
      error: "missing_scope",
      needed: "im:read",
    })
    await expectError("users.conversations", { types: "private_channel" }, token, "missing_scope")
  })

  it("opens a DM with im:write and a group DM with mpim:write", async () => {
    const w = await workspace()
    const [bob, cleo] = [await w.addUser("bob"), await w.addUser("cleo")]
    const token = await narrow(w.teamId, w.owner.id, ["im:write"])
    await ok("conversations.open", { users: bob.id }, token)
    expect(await call("conversations.open", { users: `${bob.id},${cleo.id}` }, token)).toMatchObject({
      error: "missing_scope",
      needed: "mpim:write",
    })
  })

  it("lets a bot post in a public channel it isn't in only with chat:write.public", async () => {
    const w = await workspace()
    const app = await w.addApp("Heraldo")
    // Not #general: everyone, bots too, is in that.
    const plaza = (await ok<{ channel: { id: string } }>("conversations.create", { name: "plaza" }, w.owner.token)).channel
      .id
    const bot = await issueToken(env, {
      teamId: w.teamId,
      kind: "bot",
      userId: app.botUserId,
      appId: app.id,
      scopes: ["chat:write"],
    })
    await expectError("chat.postMessage", { channel: plaza, text: "Bonjour" }, bot, "not_in_channel")
    await ok("chat.postMessage", { channel: plaza, text: "Bonjour" }, app.botToken)
  })

  it("holds for MCP tools too, which call the same methods", async () => {
    const w = await workspace()
    const token = await narrow(w.teamId, w.owner.id, ["channels:read"])
    const res = await SELF.fetch(
      new Request(`${ORIGIN}/mcp`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          "mcp-protocol-version": "2025-06-18",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "send_message", arguments: { conversation: w.general, text: "hej" } },
        }),
      }),
    )
    const text = await res.text()
    expect(text).toContain("missing_scope")
  })
})

describe("stored scopes", () => {
  it("expands a preset when the token is used", async () => {
    const w = await workspace()
    const reader = await narrow(w.teamId, w.owner.id, ["read"])
    await ok("conversations.history", { channel: w.general }, reader)
    await ok("search.messages", { query: "café" }, reader)
    await expectError("chat.postMessage", { channel: w.general, text: "no" }, reader, "missing_scope")
    const res = await SELF.fetch(new Request(`${ORIGIN}/api/auth.test`, { headers: { authorization: `Bearer ${reader}` } }))
    expect(res.headers.get("x-oauth-scopes")!.split(",")).toEqual(PRESETS.read)
  })

  it("gives a person's own tokens every user scope, and an app's bot the bot defaults", async () => {
    const w = await workspace()
    const app = await w.addApp("Vigía")
    const scopesOf = async (token: string) =>
      (await SELF.fetch(new Request(`${ORIGIN}/api/auth.test`, { headers: { authorization: `Bearer ${token}` } })))
        .headers.get("x-oauth-scopes")!
        .split(",")
    expect(await scopesOf(w.owner.token)).toEqual(FULL_USER_SCOPES)
    expect(await scopesOf(app.botToken)).toEqual(DEFAULT_BOT_SCOPES)
  })

  it("refuses an expired token with token_expired", async () => {
    const w = await workspace()
    const now = Math.floor(Date.now() / 1000)
    const live = await issueToken(env, { teamId: w.teamId, kind: "user", userId: w.owner.id, scopes: ["full"], expires: now + 60 })
    const dead = await issueToken(env, { teamId: w.teamId, kind: "user", userId: w.owner.id, scopes: ["full"], expires: now })
    await ok("auth.test", {}, live)
    await expectError("auth.test", {}, dead, "token_expired")
  })
})

describe("migration 0018", () => {
  /** Runs the migration's scope rewrite again, over rows written the way older code wrote them. */
  const rewrite = async (teamId: string) => {
    const migration = env.TEST_MIGRATIONS.find((m) => m.name.startsWith("0018"))!
    // Only this test's team: the database is shared with the other tests.
    for (const query of migration.queries.filter((q) => q.trim().startsWith("UPDATE"))) {
      await env.DB.prepare(query.replace("WHERE ", "WHERE team_id = ? AND ")).bind(teamId).run()
    }
  }

  it("makes hand-made and first-party person tokens full, bots the bot defaults, and keeps other OAuth grants", async () => {
    const w = await workspace()
    const app = await w.addApp("Antiguo")
    const old = "channels:history,channels:read,chat:write"
    const mint = (kind: "user" | "bot", userId: string, clientId?: string) =>
      issueToken(env, { teamId: w.teamId, kind, userId, scopes: [old], clientId, ...(kind === "bot" ? { appId: app.id } : {}) })
    const [hand, cli, other, bot] = await Promise.all([
      mint("user", w.owner.id),
      mint("user", w.owner.id, "campflare-cli"),
      mint("user", w.owner.id, "https://agent.example/client.json"),
      mint("bot", app.botUserId),
    ])
    await rewrite(w.teamId)
    const stored = async (token: string) => {
      const hash = [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token)))]
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("")
      return (await env.DB.prepare("SELECT scopes FROM tokens WHERE hash = ?").bind(hash).first<{ scopes: string }>())!.scopes
    }
    expect(await stored(hand)).toBe("full")
    expect(await stored(cli)).toBe("full")
    expect(await stored(other)).toBe(old)
    expect(await stored(bot)).toBe("bot")
  })
})

describe("campflare.tokens.create", () => {
  type Created = { token: string; scopes: string[]; expires: number | null }
  type Listed = { tokens: { label: string; scopes: string[]; expires: number | null }[] }

  it("mints a token for an agent from a preset and scopes, which hold", async () => {
    const w = await workspace()
    const made = await ok<Created>(
      "campflare.tokens.create",
      { preset: "read", scopes: "chat:write", label: "agente" },
      w.owner.token,
    )
    expect(made.scopes).toEqual([...PRESETS.read!, "chat:write"])
    await ok("chat.postMessage", { channel: w.general, text: "Hallo, こんにちは" }, made.token)
    await expectError("reactions.add", { channel: w.general, name: "eyes", timestamp: "1.000001" }, made.token, "missing_scope")
    const listed = await ok<Listed>("campflare.tokens.list", {}, w.owner.token)
    expect(listed.tokens.find((t) => t.label === "agente")).toMatchObject({ scopes: ["read", "chat:write"], expires: null })
  })

  it("copies the caller's scopes when asked for none, and never grants more than the caller holds", async () => {
    const w = await workspace()
    expect((await ok<Created>("campflare.tokens.create", {}, w.owner.token)).scopes).toEqual(FULL_USER_SCOPES)
    const reader = (await ok<Created>("campflare.tokens.create", { preset: "read,tokens:write" }, w.owner.token)).token
    // A narrow token hands on what it has, as a list: its own presets can't grow past it.
    const sub = await ok<Created>("campflare.tokens.create", { scopes: "search:read" }, reader)
    expect(sub.scopes).toEqual(["search:read"])
    const copy = await ok<Created>("campflare.tokens.create", {}, reader)
    expect(copy.scopes).toEqual([...PRESETS.read!, "tokens:write"])
    expect(await call("campflare.tokens.create", { preset: "write" }, reader)).toMatchObject({
      error: "missing_scope",
      needed: expect.stringContaining("chat:write"),
    })
  })

  it("refuses a scope or preset it doesn't know", async () => {
    const w = await workspace()
    expect(await call("campflare.tokens.create", { scopes: "chat:write,admin:everything" }, w.owner.token)).toMatchObject({
      error: "invalid_arguments",
      response_metadata: { messages: ["[ERROR] unknown scopes or presets: admin:everything"] },
    })
    await expectError("campflare.tokens.create", { preset: "bot" }, w.owner.token, "invalid_arguments")
  })

  it("makes a token that expires", async () => {
    const w = await workspace()
    const before = Math.floor(Date.now() / 1000)
    const made = await ok<Created>("campflare.tokens.create", { preset: "read", expires_in: 3600 }, w.owner.token)
    expect(made.expires).toBeGreaterThanOrEqual(before + 3600)
    await ok("auth.test", {}, made.token)
    await expectError("campflare.tokens.create", { expires_in: 5 }, w.owner.token, "invalid_arguments")
  })
})

describe("campflare.methods.list", () => {
  it("says, without a token, what each method takes and what each preset holds", async () => {
    type Listed = {
      methods: { name: string; tokens: string[]; scopes: string[]; conversation_scope?: string }[]
      presets: Record<string, string[]>
    }
    const list = await ok<Listed>("campflare.methods.list")
    const byName = new Map(list.methods.map((m) => [m.name, m]))
    expect(byName.get("chat.postMessage")).toEqual({ name: "chat.postMessage", tokens: ["user", "bot"], scopes: ["chat:write"] })
    expect(byName.get("conversations.history")).toMatchObject({ conversation_scope: "history", scopes: expect.arrayContaining(["groups:history"]) })
    expect(byName.get("apps.connections.open")!.tokens).toEqual(["app"])
    expect(byName.size).toBe(methods.size)
    expect(list.presets.full).toEqual(FULL_USER_SCOPES)
  })
})
