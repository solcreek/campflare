import type { PushSubscriptionInfo, Workspace } from "@campflare/core"
import { OPEN_ROUTE } from "./sw"

// Push notifications in the browser (docs/push.md): the service worker, the
// permission, the browser's push subscription and the server's copy of it.
// Every browser API comes through a PushPlatform, so tests hand in a fake one.

/**
 * - unsupported: no service worker, Push API or notifications here (the
 *   desktop shell's webview, an old browser, iOS before the app is installed);
 * - unconfigured: the server has no VAPID keys;
 * - denied: the person blocked notifications for the app;
 * - off / on: whether this browser is subscribed.
 */
export type PushState = "unsupported" | "unconfigured" | "denied" | "off" | "on"

export interface BrowserSubscription {
  endpoint: string
  options: { applicationServerKey: ArrayBuffer | null }
  toJSON(): { endpoint?: string; keys?: Record<string, string> }
  unsubscribe(): Promise<boolean>
}

export interface Registration {
  pushManager: {
    getSubscription(): Promise<BrowserSubscription | null>
    subscribe(options: {
      userVisibleOnly: boolean
      applicationServerKey: Uint8Array<ArrayBuffer>
    }): Promise<BrowserSubscription>
  }
}

export interface PushPlatform {
  notification?: {
    readonly permission: NotificationPermission
    requestPermission(): Promise<NotificationPermission>
  }
  serviceWorker?: {
    register(url: string, options: { scope: string }): Promise<unknown>
    readonly ready: Promise<Registration>
    addEventListener(type: "message", listener: (event: MessageEvent) => void): void
  }
  /** Whether the Push API exists at all (PushManager). */
  push: boolean
  userAgent: string
  /** iOS: running from the home screen, the only place Safari allows push. */
  standalone: boolean
  /** Where whose subscription this browser holds is remembered (localStorage). */
  storage?: Pick<Storage, "getItem" | "setItem" | "removeItem">
}

/** The browser's own, read when called (tests stub the globals first). */
export function browserPlatform(g: typeof globalThis = globalThis): PushPlatform {
  const nav = g.navigator as Navigator & { standalone?: boolean }
  const desktop = "__TAURI__" in g
  return {
    notification: "Notification" in g ? g.Notification : undefined,
    // The desktop shell's webview has no Push API: it'll get native notifications instead.
    serviceWorker:
      !desktop && nav && "serviceWorker" in nav ? (nav.serviceWorker as PushPlatform["serviceWorker"]) : undefined,
    push: "PushManager" in g,
    userAgent: nav?.userAgent ?? "",
    standalone: Boolean(nav?.standalone) || Boolean(g.matchMedia?.("(display-mode: standalone)").matches),
    storage: storageOf(g),
  }
}

/** localStorage, if the browser lets the page have it (a private window may not). */
function storageOf(g: typeof globalThis): PushPlatform["storage"] {
  try {
    return g.localStorage ?? undefined
  } catch {
    return undefined
  }
}

/**
 * Whose subscription this browser holds: the server and person it was made
 * for, so a later sign-in by someone else never adopts it (their devices list
 * would gain a browser, and the browser their notifications).
 */
export const OWNER_KEY = "campflare.push.owner"

/** The signed-in person, as OWNER_KEY records them. */
function ownerOf(workspace: Workspace): string | undefined {
  const self = workspace.getState().self
  return self ? `${self.url} ${self.userId}` : undefined
}

function storedOwner(p: PushPlatform): string | null {
  try {
    return p.storage?.getItem(OWNER_KEY) ?? null
  } catch {
    return null
  }
}

function keepOwner(p: PushPlatform, owner: string | undefined) {
  try {
    if (owner) p.storage?.setItem(OWNER_KEY, owner)
    else p.storage?.removeItem(OWNER_KEY)
  } catch {
    // Without storage, the next load finds no owner and asks again: safe.
  }
}

/** Whether this browser's subscription was made for the person signed in now. */
const isOwn = (workspace: Workspace, p: PushPlatform) => {
  const owner = ownerOf(workspace)
  return owner !== undefined && storedOwner(p) === owner
}

const supported = (p: PushPlatform) => Boolean(p.notification && p.serviceWorker && p.push)

/** iOS without the app on the home screen: push needs it installed. */
export const needsInstall = (p: PushPlatform) => /iPhone|iPad|iPod/.test(p.userAgent) && !p.standalone

/**
 * Registers the service worker (at the app's root, so its scope is the whole
 * app) and follows its "open this route" messages, which a notification click
 * sends to a window that is already open.
 */
export async function registerServiceWorker(p: PushPlatform, onRoute: (route: string) => void): Promise<void> {
  if (!p.serviceWorker) return
  p.serviceWorker.addEventListener("message", (event) => {
    const data = event.data as { type?: string; route?: unknown } | null
    if (data?.type === OPEN_ROUTE && typeof data.route === "string" && data.route.startsWith("#")) onRoute(data.route)
  })
  await p.serviceWorker.register("./sw.js", { scope: "./" })
}

/** A base64url key as bytes, for applicationServerKey. */
export function keyBytes(key: string): Uint8Array<ArrayBuffer> {
  const b64 = key.replaceAll("-", "+").replaceAll("_", "/")
  const binary = atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4))
  return Uint8Array.from(binary, (c) => c.charCodeAt(0))
}

const sameKey = (a: ArrayBuffer | null, b: Uint8Array) =>
  a !== null && a.byteLength === b.length && new Uint8Array(a).every((x, i) => x === b[i])

/** "Firefox on Linux", "Safari on iOS": how the device list names this browser. */
export function deviceLabel(userAgent: string): string {
  const browser = /Edg\//.test(userAgent)
    ? "Edge"
    : /OPR\//.test(userAgent)
      ? "Opera"
      : /Firefox\/|FxiOS/.test(userAgent)
        ? "Firefox"
        : /Chrome\/|CriOS/.test(userAgent)
          ? "Chrome"
          : /Safari\//.test(userAgent)
            ? "Safari"
            : "Browser"
  const os = /iPhone|iPad|iPod/.test(userAgent)
    ? "iOS"
    : /Android/.test(userAgent)
      ? "Android"
      : /CrOS/.test(userAgent)
        ? "ChromeOS"
        : /Mac OS X|Macintosh/.test(userAgent)
          ? "macOS"
          : /Windows/.test(userAgent)
            ? "Windows"
            : /Linux/.test(userAgent)
              ? "Linux"
              : ""
  return os ? `${browser} on ${os}` : browser
}

function subscriptionInfo(sub: BrowserSubscription): PushSubscriptionInfo {
  const json = sub.toJSON()
  return { endpoint: sub.endpoint, keys: { p256dh: json.keys?.p256dh ?? "", auth: json.keys?.auth ?? "" } }
}

async function subscribe(
  workspace: Workspace,
  p: PushPlatform,
  registration: Registration,
  key: Uint8Array<ArrayBuffer>,
) {
  const sub = await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key })
  await workspace.subscribePush(subscriptionInfo(sub), deviceLabel(p.userAgent))
  keepOwner(p, ownerOf(workspace))
}

/**
 * Where push stands in this browser, putting things right on the way: a
 * subscription made for someone else (another person signed in here before,
 * and didn't sign out) is dropped, never adopted; one made with another server
 * key (the keys changed) is replaced; and one the server may have dropped is
 * told again.
 */
export async function currentPush(workspace: Workspace, p: PushPlatform): Promise<PushState> {
  if (!supported(p)) return "unsupported"
  const key = await workspace.pushKey()
  if (!key) return "unconfigured"
  if (p.notification!.permission === "denied") return "denied"
  const registration = await p.serviceWorker!.ready
  const sub = await registration.pushManager.getSubscription()
  if (!sub || p.notification!.permission !== "granted") return "off"
  if (!isOwn(workspace, p)) {
    await sub.unsubscribe()
    keepOwner(p, undefined)
    return "off"
  }
  const bytes = keyBytes(key)
  if (sameKey(sub.options.applicationServerKey, bytes)) {
    await workspace.subscribePush(subscriptionInfo(sub), deviceLabel(p.userAgent))
  } else {
    await sub.unsubscribe()
    await workspace.unsubscribePush(sub.endpoint)
    await subscribe(workspace, p, registration, bytes)
  }
  return "on"
}

/** Asks for permission (call it from the click: browsers want a gesture), then subscribes. */
export async function turnOnPush(workspace: Workspace, p: PushPlatform): Promise<PushState> {
  if (!supported(p)) return "unsupported"
  const permission = await p.notification!.requestPermission()
  if (permission === "denied") return "denied"
  if (permission !== "granted") return "off"
  const key = await workspace.pushKey()
  if (!key) return "unconfigured"
  const registration = await p.serviceWorker!.ready
  const old = await registration.pushManager.getSubscription()
  const bytes = keyBytes(key)
  // Someone else's, or made with another key: a fresh one replaces it.
  if (old && (!sameKey(old.options.applicationServerKey, bytes) || !isOwn(workspace, p))) await old.unsubscribe()
  await subscribe(workspace, p, registration, bytes)
  return "on"
}

/** Unsubscribes this browser, here and on the server. */
export async function turnOffPush(workspace: Workspace, p: PushPlatform): Promise<PushState> {
  if (!supported(p)) return "unsupported"
  const registration = await p.serviceWorker!.ready
  const sub = await registration.pushManager.getSubscription()
  if (sub) {
    await sub.unsubscribe()
    await workspace.unsubscribePush(sub.endpoint)
  }
  keepOwner(p, undefined)
  return "off"
}

/**
 * Signing out: this browser stops getting the person's notifications. The
 * server forgets the subscription (best effort: the token still works now) and
 * the browser drops it, whoever it was made for.
 */
export async function signOutPush(workspace: Workspace, p: PushPlatform): Promise<void> {
  if (!supported(p)) return
  const registration = await p.serviceWorker!.ready
  const sub = await registration.pushManager.getSubscription()
  if (sub) {
    if (isOwn(workspace, p)) await workspace.unsubscribePush(sub.endpoint).catch(() => undefined)
    await sub.unsubscribe().catch(() => false)
  }
  keepOwner(p, undefined)
}
