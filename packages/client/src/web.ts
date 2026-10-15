// The Web API: https://<host>/api/<method>. Works against Campflare and
// against slack.com alike; only the base URL differs.

export type Fetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>

export type ApiArgs = Record<string, string | number | boolean | object | undefined | null>

export interface ApiResult {
  ok: boolean
  error?: string
  response_metadata?: { next_cursor?: string; messages?: string[] }
  [key: string]: unknown
}

export class ApiError extends Error {
  readonly method: string
  readonly code: string
  readonly data: ApiResult

  constructor(method: string, data: ApiResult) {
    super(`${method} failed: ${data.error ?? "unknown_error"}`)
    this.method = method
    this.code = data.error ?? "unknown_error"
    this.data = data
  }
}

export interface ClientOptions {
  /** The server: "https://campflare.example.com", or "https://slack.com". */
  url: string
  token?: string
  fetch?: Fetch
  /** Retries after HTTP 429 before giving up. */
  maxRetries?: number
  sleep?: (ms: number) => Promise<void>
}

export interface UploadFile {
  name: string
  bytes: Uint8Array<ArrayBuffer>
  title?: string
}

export interface UploadOptions {
  channel?: string
  text?: string
  threadTs?: string
  onUploaded?: (files: { id: string; title: string }[]) => void
}

export interface Client {
  readonly url: string
  call<T extends ApiResult = ApiResult>(method: string, args?: ApiArgs): Promise<T>
  /** Every item under `key`, following response_metadata.next_cursor. */
  paginate<T>(method: string, key: string, args?: ApiArgs): Promise<T[]>
  /**
   * files.getUploadURLExternal → POST bytes → files.completeUploadExternal. `onUploaded` gets
   * the files' ids once every file's bytes are stored, just before they are shared.
   */
  upload(files: UploadFile[], opts?: UploadOptions): Promise<{ id: string; title: string }[]>
  /**
   * GETs a file the server serves with this client's token: a file's url_private or
   * url_private_download. Only the server's origin or its subdomains (Slack's files.slack.com)
   * are sent the token; any other URL throws without a request.
   */
  fetchFile(url: string, init?: { headers?: Record<string, string>; signal?: AbortSignal }): Promise<Response>
  /** auth.test, with the token's scopes, which the server reports in its `x-oauth-scopes` header, as Slack does. */
  authTest<T extends ApiResult = ApiResult>(): Promise<T & { scopes: string[] }>
}

export function apiBase(url: string): string {
  return `${url.replace(/\/+$/, "").replace(/\/api$/, "")}/api/`
}

/** Form-encodes args as the Slack SDKs do: objects become JSON strings. */
function form(args: ApiArgs): URLSearchParams {
  const body = new URLSearchParams()
  for (const [k, v] of Object.entries(args)) {
    if (v === undefined || v === null) continue
    body.set(k, typeof v === "object" ? JSON.stringify(v) : String(v))
  }
  return body
}

export function createClient(options: ClientOptions): Client {
  const fetch = options.fetch ?? globalThis.fetch
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  const maxRetries = options.maxRetries ?? 3
  const base = apiBase(options.url)
  const auth: Record<string, string> = options.token ? { authorization: `Bearer ${options.token}` } : {}

  async function call<T extends ApiResult = ApiResult>(method: string, args: ApiArgs = {}): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      const res = await fetch(`${base}${method}`, { method: "POST", headers: auth, body: form(args) })
      if (res.status === 429 && attempt < maxRetries) {
        await sleep(Number(res.headers.get("retry-after") ?? "1") * 1000)
        continue
      }
      const data = (await res.json().catch(() => ({ ok: false, error: `http_${res.status}` }))) as ApiResult
      if (!data.ok) throw new ApiError(method, data)
      return data as T
    }
  }

  async function authTest<T extends ApiResult = ApiResult>(): Promise<T & { scopes: string[] }> {
    const res = await fetch(`${base}auth.test`, { method: "POST", headers: auth, body: form({}) })
    const data = (await res.json().catch(() => ({ ok: false, error: `http_${res.status}` }))) as ApiResult
    if (!data.ok) throw new ApiError("auth.test", data)
    return { ...(data as T), scopes: (res.headers.get("x-oauth-scopes") ?? "").split(",").filter(Boolean) }
  }

  async function paginate<T>(method: string, key: string, args: ApiArgs = {}): Promise<T[]> {
    const items: T[] = []
    let cursor: string | undefined
    do {
      const page = await call(method, { limit: 200, ...args, cursor })
      items.push(...((page[key] as T[] | undefined) ?? []))
      cursor = page.response_metadata?.next_cursor || undefined
    } while (cursor)
    return items
  }

  async function upload(files: UploadFile[], opts: UploadOptions = {}) {
    const done: { id: string; title: string }[] = []
    for (const file of files) {
      const { upload_url, file_id } = await call<ApiResult & { upload_url: string; file_id: string }>(
        "files.getUploadURLExternal",
        { filename: file.name, length: file.bytes.byteLength },
      )
      const res = await fetch(upload_url, { method: "POST", headers: auth, body: file.bytes })
      if (!res.ok) throw new Error(`uploading ${file.name} failed: HTTP ${res.status}`)
      done.push({ id: file_id, title: file.title ?? file.name })
    }
    opts.onUploaded?.(done)
    await call("files.completeUploadExternal", {
      files: done,
      channel_id: opts.channel,
      initial_comment: opts.text,
      thread_ts: opts.threadTs,
    })
    return done
  }

  const server = new URL(base)

  function fetchFile(url: string, init: { headers?: Record<string, string>; signal?: AbortSignal } = {}) {
    const target = new URL(url, server)
    const ours =
      target.origin === server.origin ||
      (target.protocol === "https:" && target.hostname.endsWith(`.${server.hostname}`))
    if (!ours) return Promise.reject(new Error(`not a file on ${server.origin}: ${target.origin}`))
    return fetch(target.href, { headers: { ...init.headers, ...auth }, signal: init.signal })
  }

  return { url: options.url, call, paginate, upload, fetchFile, authTest }
}
