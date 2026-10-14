import { escape, page } from "./auth/pages"

// The links chat.getPermalink hands out (shapes.ts `permalink`), in Slack's
// shape: <origin>/archives/<channel>/p<ts without its dot>, with
// ?thread_ts=<thread>&cid=<channel> for a reply. The Worker has no app of its
// own to show them in: it sends the browser to the app (APP_URL, wherever that
// is served) at the message's hash route, and the app does the rest: sign-in
// first if need be, then the conversation or thread with the message
// highlighted, or its not-found view. Nothing is looked up here: a browser
// following a link carries no token, so whether the message exists, and
// whether this person may see it, is the app's to find out.

const CHANNEL = /^[A-Z0-9]{2,32}$/
const PACKED_TS = /^p(\d{7,16})$/
const TS = /^\d{1,10}\.\d{6}$/

/** p1700000000000100 → 1700000000.000100: the last six digits are the fraction. */
export function unpackTs(packed: string): string | undefined {
  const digits = PACKED_TS.exec(packed)?.[1]
  return digits ? `${digits.slice(0, -6)}.${digits.slice(-6)}` : undefined
}

/**
 * The app's hash route for a permalink (apps/web/src/route.ts): `#/<channel>?msg=<ts>`
 * for a message in a conversation, `#/<channel>/<thread>?msg=<ts>` for a reply.
 * A link to the conversation alone (`/archives/<channel>`), or with a message
 * part that isn't one, opens the conversation. Undefined for no channel id.
 */
export function permalinkRoute(channel: string, packed?: string, threadTs?: string | null): string | undefined {
  if (!CHANNEL.test(channel)) return undefined
  const ts = packed ? unpackTs(packed) : undefined
  if (!ts) return `#/${channel}`
  const thread = threadTs && TS.test(threadTs) && threadTs !== ts ? `/${threadTs}` : ""
  return `#/${channel}${thread}?msg=${ts}`
}

/** The desktop app's URL scheme (apps/desktop: tauri-plugin-deep-link). */
export const DESKTOP_SCHEME = "campflare"

/**
 * The same link for the desktop app: the permalink with its scheme changed,
 * `campflare://<host>/archives/<channel>/p<ts>` (`?thread_ts=<thread>&cid=<channel>`
 * for a reply). The host says which server the message is on; the app opens it
 * when that's the server it is signed in to (apps/web/src/deep-link.ts).
 * Rebuilt from the parts permalinkRoute accepts, so nothing else of the request
 * gets into it. Undefined for no channel id.
 */
export function desktopLink(host: string, channel: string, packed?: string, threadTs?: string | null) {
  if (!CHANNEL.test(channel)) return undefined
  const ts = packed ? unpackTs(packed) : undefined
  if (!ts) return `${DESKTOP_SCHEME}://${host}/archives/${channel}`
  const thread = threadTs && TS.test(threadTs) && threadTs !== ts ? `?thread_ts=${threadTs}&cid=${channel}` : ""
  return `${DESKTOP_SCHEME}://${host}/archives/${channel}/${packed}${thread}`
}

export interface PermalinkOptions {
  /** Where the app is served (APP_URL): the browser goes there, at the message's route. */
  appUrl?: string
  /**
   * OFFER_DESKTOP_APP: answer a page offering the desktop app and the browser,
   * instead of the redirect. Off by default: a redirect is one click less for
   * everyone without the desktop app, and a page never launches the app by itself.
   */
  offerDesktop?: boolean
}

/** OFFER_DESKTOP_APP is on when it's "true" or "1". */
export const offersDesktop = (value: string | undefined) => value === "true" || value === "1"

/**
 * GET /archives/:channel(/:ts): a redirect to the app; with offerDesktop, a
 * page with a link to each of the desktop app and the web app; without an
 * app to send the browser to, a page naming the route, and the desktop link.
 */
export function handlePermalink(
  { appUrl, offerDesktop = false }: PermalinkOptions,
  url: URL,
  channel: string,
  packed?: string,
): Response {
  const threadTs = url.searchParams.get("thread_ts")
  const route = permalinkRoute(channel, packed, threadTs)
  const desktop = desktopLink(url.host, channel, packed, threadTs)
  if (!route || !desktop) return new Response("not a Campflare link", { status: 404 })
  const openDesktop = `<a class="button primary" href="${escape(desktop)}">Open in the desktop app</a>`
  let web: string | undefined
  if (appUrl) {
    const target = new URL(appUrl)
    target.hash = route
    web = target.href
    if (!offerDesktop)
      return new Response(null, { status: 302, headers: { location: web, "cache-control": "no-store" } })
  }
  if (web)
    return page(
      "Open in Campflare",
      `<h1>Open in Campflare</h1>
<p>This is a link to a message on this Campflare server.</p>
<div class="row">${openDesktop}<a class="button" href="${escape(web)}">Open in your browser</a></div>`,
      url,
    )
  // The route is made of the patterns above only (letters, digits, dots), so it is safe in HTML as is.
  return page(
    "Open in Campflare",
    `<h1>Open in Campflare</h1>
<p>This is a link to a message on this Campflare server, but the server doesn't know where its app is (its operator sets <code>APP_URL</code>).</p>
<p>In the Campflare app, open <code>${route}</code>.</p>
<div class="row">${openDesktop}</div>`,
    url,
  )
}
