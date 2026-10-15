import { SELF } from "cloudflare:test"
import { env } from "cloudflare:workers"
import { describe, expect, it } from "vitest"
import "../src/index"
import { issueToken } from "../src/api/auth"
import { methods } from "../src/api/context"
import { acceptedScopes, NEEDS } from "../src/api/scopes"
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
