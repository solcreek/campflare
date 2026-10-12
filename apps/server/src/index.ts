import { Hono } from "hono"
import { cors } from "hono/cors"
import type { Env } from "./env"
import "./methods/admin"
import "./methods/auth"
import "./methods/chat"
import "./methods/conversations"
import "./methods/dnd"
import "./methods/events"
import { handleDownload, handleUpload } from "./methods/files"
import "./methods/reactions"
import "./methods/search"
import "./methods/users"
import { handleMcp } from "./mcp"
import { Args } from "./api/args"
import { authenticate, tokenOf, touch } from "./api/auth"
import { methods, type Auth, type Ctx } from "./api/context"
import { CampflareError } from "./api/errors"
import { readTicket } from "./api/tickets"

export { TeamHub } from "./hub"

const app = new Hono<{ Bindings: Env }>()

app.use("/api/*", cors({ origin: "*", allowHeaders: ["Authorization", "Content-Type"], maxAge: 86_400 }))

app.get("/", (c) => c.json({ name: "campflare", api: `${new URL(c.req.url).origin}/api/` }))

/** The Slack Web API: https://<host>/api/<method>, by GET or POST. */
app.on(["GET", "POST"], "/api/:method", async (c) => {
  const name = c.req.param("method")
  const def = methods.get(name)
  const reply = (body: Record<string, unknown>, headers: Record<string, string> = {}) =>
    c.json(body, 200, { "x-campflare-req-id": crypto.randomUUID(), ...headers })
  if (!def) return reply({ ok: false, error: "unknown_method", req_method: name })

  try {
    const args = await Args.from(c.req.raw)
    let auth: Auth | undefined
    if (def.access !== "none") {
      const token = tokenOf(c.req.raw, args.str("token"))
      if (!token) throw new CampflareError("not_authed")
      auth = await authenticate(c.env, token)
      const allowed = def.access === "actor" ? auth.kind === "user" || auth.kind === "bot" : auth.kind === def.access
      if (!allowed) throw new CampflareError("not_allowed_token_type")
      if (auth.user) {
        const pending = touch(c.env, auth.user)
        if (pending) c.executionCtx.waitUntil(pending)
      }
    }
    const ctx: Ctx<Auth | undefined> = {
      env: c.env,
      args,
      auth,
      request: c.req.raw,
      origin: new URL(c.req.url).origin,
      waitUntil: (p) => c.executionCtx.waitUntil(p),
    }
    const result = await def.handler(ctx)
    return reply({ ok: true, ...result }, auth ? { "x-oauth-scopes": auth.scopes.join(",") } : {})
  } catch (error) {
    if (error instanceof CampflareError) return reply({ ok: false, error: error.code, ...error.extra })
    console.error(`${name} failed`, error)
    return reply({ ok: false, error: "internal_error" })
  }
})

/** The remote MCP server (Streamable HTTP). */
app.all("/mcp", (c) => handleMcp(c.env, c.req.raw, (p) => c.executionCtx.waitUntil(p)))

/** Upload URLs handed out by files.getUploadURLExternal. */
app.post("/upload/v1/:token", (c) => handleUpload(c.env, c.req.raw, c.req.param("token")))

/** url_private and url_private_download. */
app.get("/files-pri/:teamFile/download/:name", (c) => handleDownload(c.env, c.req.raw, c.req.param("teamFile"), true))
app.get("/files-pri/:teamFile/:name", (c) => handleDownload(c.env, c.req.raw, c.req.param("teamFile"), false))

/** WebSocket URLs from apps.connections.open (Socket Mode) and rtm.connect. */
app.get("/link/", async (c) => {
  const ticket = await readTicket(c.env.SIGNING_KEY, c.req.query("ticket") ?? "")
  if (!ticket) return c.text("invalid or expired ticket", 401)
  const stub = c.env.HUB.get(c.env.HUB.idFromName(ticket.teamId))
  const headers = new Headers(c.req.raw.headers)
  headers.set("x-campflare-connection", JSON.stringify(ticket))
  return stub.fetch(new Request(c.req.raw.url, { headers }))
})

/** Placeholder avatars: initials on a colour, as an SVG. */
app.get("/avatars/:id", (c) => {
  const id = c.req.param("id")
  const hue = [...id].reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) % 360, 0)
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" fill="hsl(${hue} 55% 45%)"/></svg>`
  return c.body(svg, 200, { "content-type": "image/svg+xml", "cache-control": "public, max-age=86400" })
})

export default app
