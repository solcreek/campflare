import { useCallback, useSyncExternalStore } from "react"

// Where the app is, in the URL hash: #/C123, or #/C123/1700000000.000100 with a
// thread open. Hash routes work from a file:// or tauri:// origin as well as a
// web host, and every screen has a URL an agent or a test can open directly.

export interface Route {
  channel?: string
  thread?: string
}

export function parseRoute(hash: string): Route {
  const [channel, thread] = hash.replace(/^#\/?/, "").split("/")
  return { channel: channel || undefined, thread: thread || undefined }
}

export function formatRoute(route: Route): string {
  if (!route.channel) return "#/"
  return route.thread ? `#/${route.channel}/${route.thread}` : `#/${route.channel}`
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
