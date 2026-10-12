import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client"
import { describe, expect, inject, it } from "vitest"
import { seed } from "../../scripts/seed.ts"

// The official MCP client in Node, over real HTTP to wrangler dev, as an
// agent host such as Claude Code would connect.

const base = inject("baseUrl")

async function connect(token: string, era: "modern" | "legacy") {
  const client = new Client(
    { name: "conformance", version: "1.0.0" },
    era === "modern" ? { versionNegotiation: { mode: "auto" } } : {},
  )
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${token}` } },
    }),
  )
  return client
}

type ToolResult = { structuredContent?: Record<string, unknown>; isError?: boolean }

describe("MCP over HTTP", () => {
  for (const era of ["modern", "legacy"] as const) {
    it(`reads the seeded workspace and waits for a reply (${era})`, async () => {
      const team = await seed(base, "conformance", `MCP ${era} ${Date.now()}`)
      const client = await connect(team.owner, era)
      // "auto" probes with server/discover: the server must answer as a 2026-07-28 server.
      expect(client.getProtocolEra()).toBe(era)
      expect(client.getNegotiatedProtocolVersion()).toBe(era === "modern" ? "2026-07-28" : "2025-11-25")
      const read = (await client.callTool({
        name: "read_messages",
        arguments: { conversation: "#world", limit: 3 },
      })) as ToolResult
      expect(read.structuredContent?.messages).toEqual([
        expect.objectContaining({ text: "Buenos días a todos", from: "@minjun" }),
        expect.objectContaining({ text: "Bonjour à tous", from: "@ada" }),
        expect.objectContaining({ text: "Guten Morgen zusammen", from: "@vincent" }),
      ])

      const asked = (await client.callTool({
        name: "send_message",
        arguments: { conversation: "@vincent", text: "Can you review the PR?" },
      })) as ToolResult
      const waiting = client.callTool({
        name: "wait_for_reply",
        arguments: { conversation: "@vincent", timeout_seconds: 10 },
      }) as Promise<ToolResult>
      await new Promise((r) => setTimeout(r, 300))
      const vincent = team.people.vincent!
      await fetch(`${base}/api/chat.postMessage`, {
        method: "POST",
        headers: { authorization: `Bearer ${vincent}` },
        body: new URLSearchParams({ channel: String(asked.structuredContent?.conversation), text: "On it" }),
      })
      expect((await waiting).structuredContent).toMatchObject({
        replied: true,
        message: { from: "@vincent", text: "On it" },
      })
      await client.close()
    })
  }

  it("answers 401 with a Bearer challenge without a token", async () => {
    const res = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    })
    expect(res.status).toBe(401)
    expect(res.headers.get("www-authenticate")).toMatch(/^Bearer /)
  })
})
