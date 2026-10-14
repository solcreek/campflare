import { page } from "./auth/pages"

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

/** GET /archives/:channel(/:ts): a redirect to the app, or a page saying where to look when APP_URL is unset. */
export function handlePermalink(appUrl: string | undefined, url: URL, channel: string, packed?: string): Response {
  const route = permalinkRoute(channel, packed, url.searchParams.get("thread_ts"))
  if (!route) return new Response("not a Campflare link", { status: 404 })
  if (appUrl) {
    const target = new URL(appUrl)
    target.hash = route
    return new Response(null, { status: 302, headers: { location: target.href, "cache-control": "no-store" } })
  }
  // The route is made of the patterns above only (letters, digits, dots), so it is safe in HTML as is.
  return page(
    "Open in Campflare",
    `<h1>Open in Campflare</h1>
<p>This is a link to a message on this Campflare server, but the server doesn't know where its app is (its operator sets <code>APP_URL</code>).</p>
<p>In the Campflare app, open <code>${route}</code>.</p>`,
    url,
  )
}
