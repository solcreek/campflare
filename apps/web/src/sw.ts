// The service worker (docs/push.md): it shows the server's push notifications
// and opens the app at the message when one is clicked. Nothing else: no
// caching, no fetch handler, so it never stands between the app and the network.
//
// It is served as /sw.js, a classic script: the Vite plugin in vite.config.ts
// strips the types and the `export` keywords from this file (so it must not
// import anything), and the handlers stay plain functions that tests call.

/** What the server pushes (src/push/payload.ts on the server). */
export interface PushPayload {
  title?: string
  body?: string
  tag?: string
  /** The app's hash route to open on a click, "#/C123?msg=…". */
  route?: string
}

/** The parts of the service worker's world the handlers use: a fake in tests. */
export interface WorkerScope {
  registration: {
    scope: string
    showNotification(title: string, options: NotificationOptions & { renotify?: boolean }): Promise<void>
  }
  clients: {
    matchAll(options: { type: "window"; includeUncontrolled: boolean }): Promise<WindowLike[]>
    openWindow(url: string): Promise<unknown>
  }
}

export interface WindowLike {
  url: string
  focus(): Promise<unknown>
  postMessage(message: unknown): void
}

/** The message a window of the app gets to go to a route: it sets location.hash. */
export const OPEN_ROUTE = "campflare.open"

/** A push's notification: the payload's title and body, collapsed per conversation by its tag. */
export function showPush(scope: WorkerScope, data: PushPayload | null): Promise<void> {
  const title = data?.title || "Campflare"
  return scope.registration.showNotification(title, {
    body: data?.body ?? "",
    // One per conversation: a newer one replaces it, and still rings (renotify).
    ...(data?.tag ? { tag: data.tag, renotify: true } : {}),
    icon: new URL("icons/icon-192.png", scope.registration.scope).href,
    badge: new URL("icons/badge-96.png", scope.registration.scope).href,
    data: { route: data?.route ?? "#/" },
  })
}

/** Parses a push's body; one that isn't JSON still shows, as text. */
export function readPush(data: { json(): unknown; text(): string } | null): PushPayload | null {
  if (!data) return null
  try {
    return data.json() as PushPayload
  } catch {
    return { body: data.text() }
  }
}

/** A click: focus a window of the app and send it to the route, or open one there. */
export async function openRoute(scope: WorkerScope, route: string): Promise<void> {
  const url = new URL(route.startsWith("#") ? route : "#/", scope.registration.scope).href
  const windows = await scope.clients.matchAll({ type: "window", includeUncontrolled: true })
  const open = windows.find((w) => w.url.startsWith(scope.registration.scope))
  if (!open) {
    await scope.clients.openWindow(url)
    return
  }
  open.postMessage({ type: OPEN_ROUTE, route })
  await open.focus()
}

interface ExtendableEvent extends Event {
  waitUntil(promise: Promise<unknown>): void
}

/** Wires the handlers to the worker's events: only when this runs as the service worker. */
export function install(worker: WorkerScope & EventTarget & { skipWaiting(): Promise<void> }) {
  // A new version takes over at once: it has no caches to keep in step.
  worker.addEventListener("install", () => void worker.skipWaiting())
  worker.addEventListener("push", (event) => {
    const e = event as ExtendableEvent & { data: { json(): unknown; text(): string } | null }
    e.waitUntil(showPush(worker, readPush(e.data)))
  })
  worker.addEventListener("notificationclick", (event) => {
    const e = event as ExtendableEvent & { notification: { close(): void; data?: { route?: string } } }
    e.notification.close()
    e.waitUntil(openRoute(worker, e.notification.data?.route ?? "#/"))
  })
}

if (typeof self !== "undefined" && "registration" in self && "clients" in self && !("document" in self)) {
  install(self as unknown as Parameters<typeof install>[0])
}
