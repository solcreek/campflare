import { Hono } from "hono"
import { cors } from "hono/cors"
import type { Env } from "./env"
import "./methods/activity"
import "./methods/admin"
import "./methods/assistant"
import "./methods/auth"
import "./methods/blocks"
import "./methods/bookmarks"
import "./methods/chat"
import "./methods/chat-stream"
import "./methods/conversations"
import "./methods/dnd"
import "./methods/events"
import "./methods/invites"
import "./methods/oauth"
import { handleDownload, handleThumb, handleUpload } from "./methods/files"
import "./huddle/methods"
import { huddlePage, huddleScript } from "./huddle/page"
import { readScribeTicket } from "./huddle/ticket"
import "./methods/pins"
import "./methods/prefs"
import "./methods/push"
import "./methods/reactions"
import "./methods/reminders"
import "./methods/scheduled"
import "./methods/search"
import "./methods/stars"
import "./methods/users"
import "./methods/usergroups"
import "./methods/views"
import { mountAuth } from "./auth/routes"
import { mountLinks } from "./auth/links"
import { handlePermalink, offersDesktop } from "./permalinks"
import { handleMcp } from "./mcp"
import { handleResponseUrl } from "./interactivity"
import { Args } from "./api/args"
import { publicOrigin } from "./api/origin"
import { authenticate, tokenOf, touch } from "./api/auth"
import { authorize, methods, type Auth, type Ctx } from "./api/context"
import { acceptedScopes, NEEDS, type Verb } from "./api/scopes"
import { CampflareError } from "./api/errors"
import { readTicket } from "./api/tickets"
import { avatarSvg } from "./api/avatar"
import { handlePhoto } from "./api/photos"
import { first } from "./db/query"
import type { UserRow } from "./db/rows"

export { TeamHub } from "./hub"
export { HuddleScribe } from "./huddle/scribe"
export { Scheduler } from "./scheduler"

const app = new Hono<{ Bindings: Env }>()

app.use(
  "/api/*",
  cors({
    origin: "*",
    allowHeaders: ["Authorization", "Content-Type"],
    // So a browser client can read a token's scopes, as @campflare/client's authTest() does.
    exposeHeaders: ["X-OAuth-Scopes", "X-Accepted-OAuth-Scopes"],
    maxAge: 86_400,
  }),
)
// Browser apps fetch url_private with their Bearer token (as Slack clients do) and
// show the bytes as a blob: URL, since <img src> can't send a header. Credentials
// are never cookies, so any origin may ask; it still needs the token.
const privateFiles = cors({
  origin: "*",
  allowMethods: ["GET", "HEAD"],
  allowHeaders: ["Authorization", "Range", "If-None-Match", "If-Modified-Since"],
  exposeHeaders: ["Content-Disposition", "Content-Length", "Content-Range", "ETag"],
  maxAge: 86_400,
})
app.use("/files-pri/*", privateFiles)
// Thumbnails (thumb_*) are fetched the same way.
app.use("/files-tmb/*", privateFiles)
// client.upload() POSTs the bytes with its Authorization header too; the URL itself is the capability.
app.use("/upload/v1/*", cors({ origin: "*", allowMethods: ["POST"], allowHeaders: ["Authorization", "Content-Type"] }))

app.get("/", (c) => c.json({ name: "campflare", api: `${publicOrigin(c.req.raw)}/api/` }))

/** The Slack Web API: https://<host>/api/<method>, by GET or POST. */
app.on(["GET", "POST"], "/api/:method", async (c) => {
  const name = c.req.param("method")
  const def = methods.get(name)
  const scopeHeaders: Record<string, string> = {}
  const reply = (body: Record<string, unknown>) =>
    c.json(body, 200, { "x-campflare-req-id": crypto.randomUUID(), ...scopeHeaders })
  if (!def) return reply({ ok: false, error: "unknown_method", req_method: name })
  const accepted = acceptedScopes(NEEDS[name] ?? [])
  if (accepted.length) scopeHeaders["x-accepted-oauth-scopes"] = accepted.join(",")

  try {
    const args = await Args.from(c.req.raw)
    let auth: Auth | undefined
    let verb: Verb | undefined
    if (def.access !== "none") {
      const token = tokenOf(c.req.raw, args.str("token"))
      if (!token) throw new CampflareError("not_authed")
      auth = await authenticate(c.env, token)
      scopeHeaders["x-oauth-scopes"] = auth.scopes.join(",")
      verb = authorize(name, def, auth)
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
      origin: publicOrigin(c.req.raw),
      waitUntil: (p) => c.executionCtx.waitUntil(p),
      verb,
    }
    const result = await def.handler(ctx)
    return reply({ ok: true, ...result })
  } catch (error) {
    if (error instanceof CampflareError) return reply({ ok: false, error: error.code, ...error.extra })
    console.error(`${name} failed`, error)
    return reply({ ok: false, error: "internal_error" })
  }
})

mountAuth(app)
// Invitation and password reset links (docs/invites.md).
mountLinks(app)

/** A test page for huddles, until there's a UI. */
app.get("/huddle", () => huddlePage())
app.get("/huddle.js", () => huddleScript())

/** The SFU's WebSocket adapter, streaming one speaker of a transcribed call. */
app.get("/huddle/scribe/:ticket", async (c) => {
  const ticket = await readScribeTicket(c.env.SIGNING_KEY, c.req.param("ticket"))
  if (!ticket) return c.text("invalid or expired ticket", 401)
  const scribe = c.env.SCRIBE.get(c.env.SCRIBE.idFromName(`${ticket.teamId}/${ticket.channelId}`))
  const headers = new Headers(c.req.raw.headers)
  headers.set("x-campflare-speaker", JSON.stringify({ user: ticket.user }))
  return scribe.fetch(new Request(c.req.raw.url, { headers }))
})

/** The remote MCP server (Streamable HTTP). */
app.all("/mcp", (c) => handleMcp(c.env, c.req.raw, (p) => c.executionCtx.waitUntil(p)))

/** response_urls handed to apps with a click (block_actions): the app's answer. */
app.post("/actions/:token", (c) =>
  handleResponseUrl(c.env, c.req.raw, c.req.param("token"), (p) => c.executionCtx.waitUntil(p)),
)

/** Upload URLs handed out by files.getUploadURLExternal. */
app.post("/upload/v1/:token", (c) => handleUpload(c.env, c.req.raw, c.req.param("token")))

/** url_private and url_private_download. */
app.get("/files-pri/:teamFile/download/:name", (c) => handleDownload(c.env, c.req.raw, c.req.param("teamFile"), true))
app.get("/files-pri/:teamFile/:name", (c) => handleDownload(c.env, c.req.raw, c.req.param("teamFile"), false))
/** thumb_64 … thumb_1024. */
app.get("/files-tmb/:teamFile/:name", (c) =>
  handleThumb(c.env, c.req.raw, c.req.param("teamFile"), c.req.param("name")),
)

/** WebSocket URLs from apps.connections.open (Socket Mode) and rtm.connect. */
app.get("/link/", async (c) => {
  const ticket = await readTicket(c.env.SIGNING_KEY, c.req.query("ticket") ?? "")
  if (!ticket) return c.text("invalid or expired ticket", 401)
  const stub = c.env.HUB.get(c.env.HUB.idFromName(ticket.teamId))
  const headers = new Headers(c.req.raw.headers)
  headers.set("x-campflare-connection", JSON.stringify(ticket))
  return stub.fetch(new Request(c.req.raw.url, { headers }))
})

/** Permalinks from chat.getPermalink, and links to a conversation: sent on to the app (APP_URL). */
const permalinkOptions = (env: Env) => ({ appUrl: env.APP_URL, offerDesktop: offersDesktop(env.OFFER_DESKTOP_APP) })
app.get("/archives/:channel", (c) =>
  handlePermalink(permalinkOptions(c.env), new URL(c.req.url), c.req.param("channel")),
)
app.get("/archives/:channel/:ts", (c) =>
  handlePermalink(permalinkOptions(c.env), new URL(c.req.url), c.req.param("channel"), c.req.param("ts")),
)

/** Placeholder avatars: initials on a colour, as an SVG. */
app.get("/avatars/:id", async (c) => {
  const id = c.req.param("id")
  const user = await first<Pick<UserRow, "name" | "real_name" | "display_name">>(
    c.env.DB,
    "SELECT name, real_name, display_name FROM users WHERE id = ?",
    id,
  )
  // The name the apps show (core's displayName), so the initials match it.
  const svg = avatarSvg(id, user ? user.display_name || user.real_name || user.name : "")
  // An hour: a renamed person's initials catch up soon enough, and lists of avatars stay cached.
  return c.body(svg, 200, { "content-type": "image/svg+xml", "cache-control": "public, max-age=3600" })
})

/** Profile photos (users.setPhoto): /avatars/<user>/<photo>_<size>.<ext>, no token, as the initials. */
app.get("/avatars/:id/:name", (c) => handlePhoto(c.env, c.req.param("id"), c.req.param("name")))

export default app
