import { requireWritable, resolveConversation } from "../db/conversations"
import { postMessage } from "../db/messages"
import { all, first, run, stmt } from "../db/query"
import type { ConversationRow, FileRow } from "../db/rows"
import { announceUnsaved, unsaveFileStatement } from "../db/stars"
import type { Env } from "../env"
import { publish } from "../events"
import { authenticate, tokenOf } from "../api/auth"
import { method, type Actor, type Auth, type Ctx } from "../api/context"
import { sign, verify } from "../api/crypto"
import { invalidArguments, CampflareError } from "../api/errors"
import { ids, nowSeconds } from "../api/ids"
import { imageSize, isAnimated, mimeOf } from "../api/media"
import { fileJson } from "../api/shapes"
import { imagesOf, isOriginal, makeThumb, THUMB_VARIANTS, thumbKey, thumbVariantOf, thumbVariants } from "../api/thumbs"

export const MAX_FILE_BYTES = 1024 * 1024 * 1024
/** Bytes buffered to read an image's size; larger files stream straight to R2. */
const SNIFF_LIMIT = 32 * 1024 * 1024

const r2Key = (f: Pick<FileRow, "team_id" | "id">) => `${f.team_id}/${f.id}`

export async function getFile(ctx: Ctx<Actor>, id: string) {
  const f = await first<FileRow>(ctx.env.DB, "SELECT * FROM files WHERE id = ? AND team_id = ?", id, ctx.auth.team.id)
  if (!f) throw new CampflareError("file_not_found")
  return f
}

/**
 * SQL that is true when the user (the first parameter, or `user`) can read one of the
 * conversations in `channels`, a JSON array of ids: they're a member, or it's
 * a public channel.
 */
export const readsOneOf = (channels: string, user = "?") => `EXISTS (
  SELECT 1 FROM json_each(${channels}) j JOIN conversations c ON c.id = j.value
  LEFT JOIN members m ON m.conversation_id = c.id AND m.user_id = ${user}
  WHERE m.user_id IS NOT NULL OR (c.kind = 'channel' AND c.is_private = 0))`

/** A file is visible to its uploader, and to anyone who can read a conversation it's shared in. */
export async function canSee(env: Env, auth: Auth & { user: NonNullable<Auth["user"]> }, f: FileRow) {
  if (f.team_id !== auth.team.id) return false
  if (f.user_id === auth.user.id) return true
  const row = await first<{ ok: number }>(env.DB, `SELECT ${readsOneOf("?")} AS ok`, f.channels, auth.user.id)
  return Boolean(row?.ok)
}

method("files.getUploadURLExternal", "actor", async (ctx) => {
  const filename = ctx.args.req("filename")
  const length = ctx.args.int("length", -1)
  if (length < 0) throw invalidArguments("missing required field: length")
  if (length > MAX_FILE_BYTES) throw new CampflareError("file_too_large")
  const id = ids.file()
  await run(
    ctx.env.DB,
    `INSERT INTO files (id, team_id, user_id, name, title, mimetype, size, alt_txt, created)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id,
    ctx.auth.team.id,
    ctx.auth.user.id,
    filename,
    filename,
    mimeOf(filename),
    length,
    ctx.args.str("alt_txt") ?? null,
    nowSeconds(),
  )
  const token = await sign(ctx.env.SIGNING_KEY, `${id}:${Date.now() + 60 * 60_000}`)
  return { upload_url: `${ctx.origin}/upload/v1/${token}`, file_id: id }
})

/** POST <upload_url>: the bytes, raw or as a multipart form's file field. */
export async function handleUpload(env: Env, request: Request, token: string): Promise<Response> {
  const payload = await verify(env.SIGNING_KEY, token)
  const [fileId, expires] = payload?.split(":") ?? []
  if (!fileId || Number(expires) < Date.now()) return new Response("invalid upload url", { status: 403 })
  const f = await first<FileRow>(env.DB, "SELECT * FROM files WHERE id = ?", fileId)
  if (!f || f.status !== "reserved") return new Response("upload not found", { status: 404 })

  const type = request.headers.get("content-type") ?? ""
  let body: ReadableStream | Uint8Array | null
  let size: number | undefined
  if (type.includes("multipart/form-data")) {
    const form = await request.formData()
    const file = [...form.values()].find((v): v is File => v instanceof File)
    if (!file) return new Response("no file in form", { status: 400 })
    body = new Uint8Array(await file.arrayBuffer())
    size = body.byteLength
  } else {
    const declared = Number(request.headers.get("content-length") ?? "NaN")
    if (f.mimetype.startsWith("image/") || !Number.isFinite(declared) || declared <= SNIFF_LIMIT) {
      body = new Uint8Array(await request.arrayBuffer())
      size = body.byteLength
    } else {
      body = request.body
      size = declared
    }
  }
  if (!body || size === undefined) return new Response("empty upload", { status: 400 })
  if (size > MAX_FILE_BYTES) return new Response("file too large", { status: 413 })
  const image = body instanceof Uint8Array && f.mimetype.startsWith("image/") ? body : undefined
  const dims = image && imageSize(image)

  await env.FILES.put(r2Key(f), body, {
    httpMetadata: { contentType: f.mimetype },
    customMetadata: { name: f.name, user: f.user_id },
  })
  await run(
    env.DB,
    "UPDATE files SET status = 'uploaded', size = ?, width = ?, height = ?, animated = ? WHERE id = ?",
    size,
    dims?.width ?? null,
    dims?.height ?? null,
    dims ? Number(isAnimated(image!)) : null,
    f.id,
  )
  return new Response(`OK - ${size}`, { status: 200, headers: { "content-type": "text/plain" } })
}

method("files.completeUploadExternal", "actor", async (ctx) => {
  const list = ctx.args.json<{ id?: string; title?: string }[]>("files")
  if (!Array.isArray(list) || list.length === 0 || list.length > 10) throw invalidArguments("files must be 1–10 items")
  const channelRef = ctx.args.str("channel_id") ?? ctx.args.list("channels")[0]
  let c: ConversationRow | undefined
  if (channelRef) {
    c = await resolveConversation(ctx, channelRef)
    await requireWritable(ctx, c)
  }
  const rows: FileRow[] = []
  for (const item of list) {
    if (!item.id) throw invalidArguments("each file needs an id")
    const f = await getFile(ctx, item.id)
    if (f.user_id !== ctx.auth.user.id) throw new CampflareError("file_not_found")
    if (f.status === "reserved") throw new CampflareError("file_upload_not_complete")
    const channels = new Set(JSON.parse(f.channels) as string[])
    if (c) channels.add(c.id)
    await run(
      ctx.env.DB,
      "UPDATE files SET status = 'complete', title = ?, channels = ? WHERE id = ?",
      item.title || f.title,
      JSON.stringify([...channels]),
      f.id,
    )
    rows.push((await getFile(ctx, f.id))!)
  }
  if (c) {
    const blocks = ctx.args.json<unknown>("blocks", "invalid_blocks")
    await postMessage(ctx, c, {
      user_id: ctx.auth.user.id,
      ...(ctx.auth.kind === "bot" && ctx.auth.app ? { bot_id: ctx.auth.app.bot_id, app_id: ctx.auth.app.id } : {}),
      text: ctx.args.str("initial_comment") ?? "",
      blocks: Array.isArray(blocks) && blocks.length > 0 ? JSON.stringify(blocks) : null,
      files: JSON.stringify(rows.map((f) => f.id)),
      thread_ts: ctx.args.ts("thread_ts") ?? null,
    })
  }
  for (const f of rows) {
    publish(ctx, {
      teamId: f.team_id,
      audience: [f.user_id],
      event: { type: "file_shared", file_id: f.id, user_id: f.user_id, file: { id: f.id }, channel_id: c?.id },
    })
  }
  return { files: rows.map((f) => ({ id: f.id, title: f.title })) }
})

method("files.info", "actor", async (ctx) => {
  const f = await getFile(ctx, ctx.args.req("file", "file_not_found"))
  if (!(await canSee(ctx.env, ctx.auth, f))) throw new CampflareError("file_not_found")
  return {
    file: fileJson(f, ctx.origin, Boolean(imagesOf(ctx.env))),
    comments: [],
    response_metadata: { next_cursor: "" },
  }
})

method("files.list", "actor", async (ctx) => {
  const count = ctx.args.int("count", 100, { min: 1, max: 1000 })
  const page = ctx.args.int("page", 1, { min: 1 })
  // Visibility is part of the query, as canSee() decides it for one file.
  const conditions = ["team_id = ?", "status = 'complete'", `(user_id = ? OR ${readsOneOf("files.channels")})`]
  const params: unknown[] = [ctx.auth.team.id, ctx.auth.user.id, ctx.auth.user.id]
  const user = ctx.args.str("user")
  if (user) {
    conditions.push("user_id = ?")
    params.push(user)
  }
  const channel = ctx.args.str("channel")
  if (channel) {
    conditions.push("EXISTS (SELECT 1 FROM json_each(files.channels) WHERE value = ?)")
    params.push(channel)
  }
  const from = ctx.args.int("ts_from", 0)
  const to = ctx.args.int("ts_to", 0)
  if (from) conditions.push(`created >= ${from}`)
  if (to) conditions.push(`created <= ${to}`)
  const visible = await all<FileRow>(
    ctx.env.DB,
    `SELECT * FROM files WHERE ${conditions.join(" AND ")} ORDER BY created DESC LIMIT 1000`,
    ...params,
  )
  const pages = Math.max(1, Math.ceil(visible.length / count))
  const thumbs = Boolean(imagesOf(ctx.env))
  return {
    files: visible.slice((page - 1) * count, page * count).map((f) => fileJson(f, ctx.origin, thumbs)),
    paging: { count, total: visible.length, page, pages },
  }
})

method("files.delete", "actor", async (ctx) => {
  const f = await getFile(ctx, ctx.args.req("file", "file_not_found"))
  const admin = ctx.auth.kind === "user" && ctx.auth.user.is_admin
  if (f.user_id !== ctx.auth.user.id && !admin) throw new CampflareError("cant_delete_file")
  // The thumbnails too, made or not: deleting a missing key is no error.
  await ctx.env.FILES.delete([r2Key(f), ...THUMB_VARIANTS.map((v) => thumbKey(f, v))])
  // Anyone's saved star on it goes with it, and they're told.
  const [, unsaved] = await ctx.env.DB.batch([
    stmt(ctx.env.DB, "DELETE FROM files WHERE id = ?", f.id),
    unsaveFileStatement(ctx.env.DB, f.id),
  ])
  announceUnsaved(ctx, f.team_id, unsaved!)
  const channels = JSON.parse(f.channels) as string[]
  const members = await all<{ user_id: string }>(
    ctx.env.DB,
    "SELECT DISTINCT user_id FROM members WHERE conversation_id IN (SELECT value FROM json_each(?))",
    f.channels,
  )
  const audience = new Set<string>([f.user_id, ...members.map((r) => r.user_id)])
  publish(ctx, {
    teamId: f.team_id,
    audience: [...audience],
    event: { type: "file_deleted", file_id: f.id, channel_ids: channels },
  })
  return {}
})

const notFound = () => new Response("not found", { status: 404 })

/** The file a /files-pri or /files-tmb URL names, when the request's Bearer token may see it; else the error response. */
async function visibleFile(env: Env, request: Request, teamFile: string): Promise<FileRow | Response> {
  const token = tokenOf(request, new URL(request.url).searchParams.get("t") ?? undefined)
  if (!token) return new Response("not authed", { status: 401 })
  let auth: Auth
  try {
    auth = await authenticate(env, token)
  } catch {
    return new Response("invalid auth", { status: 401 })
  }
  // The bytes are what files.info describes: the same scope.
  if (!auth.scopes.includes("files:read")) return new Response("missing_scope: files:read", { status: 403 })
  const [teamId, fileId] = teamFile.split("-")
  const f = fileId
    ? await first<FileRow>(env.DB, "SELECT * FROM files WHERE id = ? AND team_id = ?", fileId, teamId)
    : undefined
  if (!f || !auth.user || !(await canSee(env, { ...auth, user: auth.user }, f))) return notFound()
  return f
}

/**
 * Serves an R2 object as a private file, with ranges and conditional requests, never as this
 * origin's content. Undefined when there's no such object.
 */
async function serveObject(env: Env, request: Request, key: string, name: string, download: boolean) {
  const object = await env.FILES.get(key, { range: request.headers, onlyIf: request.headers })
  if (!object) return undefined
  const headers = new Headers()
  object.writeHttpMetadata(headers)
  headers.set("etag", object.httpEtag)
  headers.set("cache-control", "private, max-age=3600")
  headers.set(
    "content-disposition",
    `${download ? "attachment" : "inline"}; filename*=UTF-8''${encodeURIComponent(name)}`,
  )
  // Never let an uploaded HTML or SVG run as this origin.
  headers.set("content-security-policy", "sandbox")
  headers.set("x-content-type-options", "nosniff")
  if (!("body" in object)) return new Response(null, { status: 304, headers })
  const status = object.range && request.headers.has("range") ? 206 : 200
  if (status === 206 && object.range && "offset" in object.range) {
    const { offset = 0, length = object.size - offset } = object.range as { offset?: number; length?: number }
    headers.set("content-range", `bytes ${offset}-${offset + length - 1}/${object.size}`)
  }
  return new Response(object.body, { status, headers })
}

/** GET /files-pri/<team>-<file>/[download/]<name>, with the same Bearer token the API takes. */
export async function handleDownload(env: Env, request: Request, teamFile: string, download: boolean) {
  const f = await visibleFile(env, request, teamFile)
  if (f instanceof Response) return f
  return (await serveObject(env, request, r2Key(f), f.name, download)) ?? notFound()
}

/**
 * GET /files-tmb/<team>-<file>/<name>_<size>.<ext>: a thumbnail (thumb_*, deanimate_gif), with
 * the same auth as url_private. The Images binding makes it on its first fetch, and R2 keeps it
 * beside the original (concurrent first fetches each make it; the last write stays). If Images
 * fails on the file (local Images can't write GIF at all), the original is served instead,
 * uncached, so the image still shows. An animated GIF that already fits is its own thumb_<n>_gif.
 */
export async function handleThumb(env: Env, request: Request, teamFile: string, name: string) {
  const f = await visibleFile(env, request, teamFile)
  if (f instanceof Response) return f
  const variant = thumbVariantOf(name)
  const images = imagesOf(env)
  if (!images || !variant || !thumbVariants(f).includes(variant)) return notFound()
  if (isOriginal(f, variant)) return (await serveObject(env, request, r2Key(f), name, false)) ?? notFound()
  const key = thumbKey(f, variant)
  const cached = await serveObject(env, request, key, name, false)
  if (cached) return cached
  const original = await env.FILES.get(r2Key(f))
  if (!original) return notFound()
  try {
    const thumb = await makeThumb(images, f, variant, original.body)
    await env.FILES.put(key, thumb.bytes, { httpMetadata: { contentType: thumb.contentType } })
  } catch (error) {
    console.error(`thumbnail ${variant} of ${f.id} failed`, error)
    return (await serveObject(env, request, r2Key(f), f.name, false)) ?? notFound()
  }
  return (await serveObject(env, request, key, name, false)) ?? notFound()
}
