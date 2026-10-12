import { SELF } from "cloudflare:test"

export const ORIGIN = "https://campflare.test"

export type Body = Record<string, unknown> & { ok: boolean; error?: string }

/** Calls a Web API method as a form POST (as most Slack SDKs do), or as JSON with `json: true`. */
export async function call<T = Body>(
  method: string,
  args: Record<string, unknown> = {},
  token?: string,
  { json = false, get = false } = {},
): Promise<T & Body> {
  const headers: Record<string, string> = {}
  if (token) headers.authorization = `Bearer ${token}`
  let url = `${ORIGIN}/api/${method}`
  let init: RequestInit
  const flat = Object.entries(args)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => [k, typeof v === "object" ? JSON.stringify(v) : String(v)] as [string, string])
  if (get) {
    url += `?${new URLSearchParams(flat)}`
    init = { headers }
  } else if (json) {
    headers["content-type"] = "application/json; charset=utf-8"
    init = { method: "POST", headers, body: JSON.stringify(args) }
  } else {
    init = { method: "POST", headers, body: new URLSearchParams(flat) }
  }
  const res = await SELF.fetch(new Request(url, init))
  return (await res.json()) as T & Body
}

/** Like call(), but fails the test on ok: false. */
export async function ok<T = Body>(method: string, args: Record<string, unknown> = {}, token?: string, opts = {}) {
  const body = await call<T>(method, args, token, opts)
  if (!body.ok) throw new Error(`${method} failed: ${body.error} ${JSON.stringify(body)}`)
  return body
}

export async function expectError(
  method: string,
  args: Record<string, unknown>,
  token: string | undefined,
  error: string,
) {
  const body = await call(method, args, token)
  if (body.ok || body.error !== error) {
    throw new Error(`${method}: expected ${error}, got ${JSON.stringify(body)}`)
  }
  return body
}

let teams = 0

export interface Workspace {
  teamId: string
  general: string
  owner: { id: string; token: string }
  /** Adds a person; returns their id and token. */
  addUser(name: string, opts?: Record<string, unknown>): Promise<{ id: string; token: string }>
  /** Creates an app installed by the owner. */
  addApp(name: string): Promise<{ id: string; botUserId: string; botId: string; botToken: string; appToken: string }>
}

export async function workspace(name = `team${++teams}`): Promise<Workspace> {
  const res = await ok<{ team: { id: string }; user: { id: string }; token: string; general_channel: string }>(
    "campflare.bootstrap",
    {
      secret: "test-bootstrap",
      team_name: name,
      user_name: "owner",
      real_name: "Olive Owner",
      email: `owner@${name}.test`,
    },
  )
  const owner = { id: res.user.id, token: res.token }
  return {
    teamId: res.team.id,
    general: res.general_channel,
    owner,
    async addUser(userName, opts = {}) {
      const r = await ok<{ user: { id: string }; token: string }>(
        "campflare.users.create",
        { name: userName, real_name: userName.toUpperCase(), email: `${userName}@${name}.test`, ...opts },
        owner.token,
      )
      return { id: r.user.id, token: r.token }
    },
    async addApp(appName) {
      const r = await ok<{
        app: { id: string; bot_user_id: string; bot_id: string }
        bot_token: string
        app_token: string
      }>("campflare.apps.create", { name: appName }, owner.token)
      return {
        id: r.app.id,
        botUserId: r.app.bot_user_id,
        botId: r.app.bot_id,
        botToken: r.bot_token,
        appToken: r.app_token,
      }
    },
  }
}

/** Opens a WebSocket URL from apps.connections.open or rtm.connect, collecting frames. */
export async function connect(url: string) {
  const res = await SELF.fetch(new Request(url.replace(/^ws/, "http"), { headers: { upgrade: "websocket" } }))
  const ws = res.webSocket
  if (!ws) throw new Error(`no websocket: ${res.status} ${await res.text()}`)
  ws.accept()
  const frames: Record<string, unknown>[] = []
  const waiters: { test: (f: Record<string, unknown>) => boolean; resolve: (f: Record<string, unknown>) => void }[] = []
  ws.addEventListener("message", (e: MessageEvent) => {
    const frame = JSON.parse(String(e.data)) as Record<string, unknown>
    frames.push(frame)
    for (const w of waiters.slice()) {
      if (w.test(frame)) {
        waiters.splice(waiters.indexOf(w), 1)
        w.resolve(frame)
      }
    }
  })
  return {
    ws,
    frames,
    /** The first frame (already received or yet to come) that passes `test`. */
    next(test: (f: Record<string, unknown>) => boolean, timeoutMs = 2000): Promise<Record<string, unknown>> {
      const seen = frames.find(test)
      if (seen) {
        frames.splice(frames.indexOf(seen), 1)
        return Promise.resolve(seen)
      }
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`no matching frame; got ${JSON.stringify(frames)}`)), timeoutMs)
        waiters.push({
          test,
          resolve: (f) => {
            clearTimeout(timer)
            frames.splice(frames.indexOf(f), 1)
            resolve(f)
          },
        })
      })
    },
    close: () => ws.close(),
  }
}

/** Events reach the hub after the response (waitUntil); give them a moment. */
export const settle = (ms = 50) => new Promise((r) => setTimeout(r, ms))
