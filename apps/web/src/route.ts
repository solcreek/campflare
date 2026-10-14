import { useCallback, useSyncExternalStore } from "react"

// Where the app is, in the URL hash: #/C123, or #/C123/1700000000.000100 with a
// thread open. Hash routes work from a file:// or tauri:// origin as well as a
// web host, and every screen has a URL an agent or a test can open directly.
// `?msg=<ts>` points at one message, highlighted and scrolled to: in the
// conversation (#/C123?msg=…), or in the open thread (#/C123/<thread>?msg=…).
// The server's permalinks (/archives/…) redirect to these.

export interface Route {
  channel?: string
  thread?: string
  /** The message a link points at: highlighted in the thread if one is open, else in the conversation. */
  message?: string
}

export function parseRoute(hash: string): Route {
  const [path = "", query = ""] = hash.replace(/^#\/?/, "").split("?", 2)
  const [channel, thread] = path.split("/")
  const message = new URLSearchParams(query).get("msg")
  return { channel: channel || undefined, thread: thread || undefined, ...(message ? { message } : {}) }
}

export function formatRoute(route: Route): string {
  if (!route.channel) return "#/"
  const path = route.thread ? `#/${route.channel}/${route.thread}` : `#/${route.channel}`
  return route.message ? `${path}?msg=${route.message}` : path
}

function subscribe(onChange: () => void) {
  window.addEventListener("hashchange", onChange)
  return () => window.removeEventListener("hashchange", onChange)
}

export function useRoute(): [Route, (route: Route) => void] {
  const hash = useSyncExternalStore(subscribe, () => window.location.hash)
  const navigate = useCallback((route: Route) => {
    window.location.hash = formatRoute(route)
  }, [])
  return [parseRoute(hash), navigate]
}
