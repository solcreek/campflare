import { formatRoute, type Route } from "./route"

// Links that open the desktop app: a permalink (apps/server/src/permalinks.ts)
// with its scheme changed to campflare:
//
//   campflare://<host>[:<port>]/archives/<channel>[/p<ts without its dot>][?thread_ts=<thread>&cid=<channel>]
//
// The host and port name the server the message is on: the app is signed in to
// one server at a time, and opens the link only when it is that one. The shell
// (apps/desktop: tauri-plugin-deep-link, and tauri-plugin-single-instance on
// Windows and Linux) only hands the URL over; what it means is decided here.

export const SCHEME = "campflare:"

export interface DeepLink {
  /** The server the link is on: host and port, lowercase. */
  server: string
  /** Where it goes in the app. */
  route: Route
  /** The same link for a browser: the permalink on its server (http for a loopback host, else https). */
  web: string
}

const CHANNEL = /^[A-Z0-9]{2,32}$/
const PACKED_TS = /^p(\d{7,16})$/
const TS = /^\d{1,10}\.\d{6}$/

/** A campflare:// link, or null when it isn't one the app can open. */
export function parseDeepLink(href: string): DeepLink | null {
  let url: URL
  try {
    url = new URL(href)
  } catch {
    return null
  }
  // Not a special scheme, so the URL parser keeps the host as written: lowercase it here.
  const server = url.host.toLowerCase()
  if (url.protocol !== SCHEME || !server) return null
  const [archives, channel, packed, ...rest] = url.pathname.replace(/^\//, "").split("/")
  if (archives !== "archives" || !channel || !CHANNEL.test(channel) || rest.length > 0) return null
  const digits = packed ? PACKED_TS.exec(packed)?.[1] : undefined
  const route: Route = { channel }
  if (digits) {
    const message = `${digits.slice(0, -6)}.${digits.slice(-6)}`
    const thread = url.searchParams.get("thread_ts")
    if (thread && TS.test(thread) && thread !== message) route.thread = thread
    route.message = message
  }
  const loopback = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(server)
  const web = new URL(`${url.pathname}${url.search}`, `${loopback ? "http" : "https"}://${server}`)
  return { server, route, web: web.href }
}

/** The app's hash for a link: the conversation, the thread, the message. */
export const deepLinkHash = (link: DeepLink) => formatRoute(link.route)

/** The server a session is on, as a link names it. */
export function serverOf(url: string): string {
  try {
    return new URL(url).host.toLowerCase()
  } catch {
    return url
  }
}

/**
 * The links the desktop shell receives: the one it was launched with, and
 * those that come while it runs (a click on a link elsewhere). Null in a
 * browser, where links are https and the server redirects them to the app.
 */
export interface DeepLinks {
  /** The links the app was started with, if any. */
  current(): Promise<string[]>
  /** Calls `on` with each link that arrives; resolves with a function that stops listening. */
  listen(on: (urls: string[]) => void): Promise<() => void>
}

interface TauriDeepLink {
  getCurrent(): Promise<string[] | null>
  onOpenUrl(handler: (urls: string[]) => void): Promise<() => void>
}

/**
 * tauri-plugin-deep-link's API, from the global `withGlobalTauri` sets, so the
 * web build never imports `@tauri-apps/*`. Null without it (a browser).
 */
export function platformDeepLinks(global: { __TAURI__?: { deepLink?: TauriDeepLink } } = globalThis as never) {
  const api = global.__TAURI__?.deepLink
  if (!api) return null
  return {
    current: async () => (await api.getCurrent()) ?? [],
    listen: (on) => api.onOpenUrl(on),
  } satisfies DeepLinks
}
