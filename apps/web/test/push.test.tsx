import { act, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { createWorkspace } from "@campflare/core"
import { fakeApi } from "@campflare/core/testing"
import { afterEach, describe, expect, it, vi } from "vitest"
import { App } from "@/app"
import { ACTIVE_RESEND_MS, reportActivity } from "@/presence"
import {
  type BrowserSubscription,
  browserPlatform,
  currentPush,
  deviceLabel,
  keyBytes,
  needsInstall,
  type PushPlatform,
  registerServiceWorker,
  turnOffPush,
  turnOnPush,
} from "@/push"
import { browserStore } from "@/session"
import { install, OPEN_ROUTE, openRoute, readPush, showPush, type WindowLike, type WorkerScope } from "@/sw"
import { serviceWorkerSource } from "../vite.config"
import { fakeServer, FakeSocket, hello } from "./server"

const KEY = "BJQiCS-kDdMSnJJm-oewJ2ESIFX-sq5HFIE2TXDesZbHULYpnrUjid9rwNDjDehUKIZ8G_x_JsIRQA8jDTw20aA"
const OTHER_KEY = "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4"
const FIREFOX_LINUX = "Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0"

afterEach(() => {
  FakeSocket.all = []
  localStorage.clear()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

/** A browser with push: a service worker whose push manager subscribes with whatever key it's given. */
function fakeBrowser(permission: NotificationPermission = "default", answer: NotificationPermission = "granted") {
  let current: (BrowserSubscription & { unsubscribed: boolean }) | null = null
  const listeners: ((e: MessageEvent) => void)[] = []
  const made = (key: Uint8Array, n: number) => {
    const sub = {
      endpoint: `https://push.example/${n}`,
      options: { applicationServerKey: key.buffer.slice(0) as ArrayBuffer },
      unsubscribed: false,
      toJSON: () => ({ endpoint: sub.endpoint, keys: { p256dh: `p256dh-${n}`, auth: `auth-${n}` } }),
      unsubscribe: async () => {
        sub.unsubscribed = true
        if (current === sub) current = null
        return true
      },
    }
    return sub
  }
  let count = 0
  const registration = {
    pushManager: {
      getSubscription: async () => current,
      subscribe: vi.fn<(o: { applicationServerKey: Uint8Array }) => Promise<BrowserSubscription>>(
        async ({ applicationServerKey }: { applicationServerKey: Uint8Array }) => {
          current = made(applicationServerKey, ++count)
          return current
        },
      ),
    },
  }
  const notification = {
    permission,
    requestPermission: vi.fn<() => Promise<NotificationPermission>>(async () => {
      notification.permission = answer
      return answer
    }),
  }
  const platform: PushPlatform = {
    notification,
    serviceWorker: {
      register: vi.fn<() => Promise<unknown>>(async () => registration),
      ready: Promise.resolve(registration),
      addEventListener: (_type, listener) => listeners.push(listener),
    },
    push: true,
    userAgent: FIREFOX_LINUX,
    standalone: false,
  }
  return {
    platform,
    registration,
    notification,
    current: () => current,
    /** Subscribes as an earlier visit would have, with this key. */
    existing: (key: string) => (current = made(keyBytes(key), ++count)),
    message: (data: unknown) => listeners.forEach((l) => l(new MessageEvent("message", { data }))),
  }
}

function pushServer(key: string | null = KEY) {
  return fakeApi({
    "campflare.push.vapidKey": () => (key ? { key } : new Error("push_not_configured")),
    "campflare.push.subscribe": () => ({ subscription: { id: "P1" } }),
    "campflare.push.unsubscribe": () => ({ removed: ["P1"] }),
    "campflare.push.test": () => ({ sent: 1, failed: 0, removed: 0 }),
  })
}

const workspaceOn = (api: ReturnType<typeof pushServer>) => createWorkspace({ client: api.client, realtime: "none" })
const callsTo = (api: ReturnType<typeof pushServer>, method: string) => api.calls.filter((c) => c.method === method)

describe("the service worker", () => {
  function fakeScope(windows: WindowLike[] = []) {
    const shown: { title: string; options: NotificationOptions & { renotify?: boolean } }[] = []
    const scope: WorkerScope = {
      registration: {
        scope: "https://app.campflare.test/",
        showNotification: async (title, options) => void shown.push({ title, options }),
      },
      clients: {
        matchAll: async () => windows,
        openWindow: vi.fn<(url: string) => Promise<unknown>>(async () => undefined),
      },
    }
    return { scope, shown }
  }

  it("shows a push, collapsed per conversation, and something even for a bare one", async () => {
    const { scope, shown } = fakeScope()
    await showPush(scope, { title: "Olive in #général", body: "¿revisas? 確認", tag: "C1", route: "#/C1?msg=1.2" })
    expect(shown[0]).toEqual({
      title: "Olive in #général",
      options: {
        body: "¿revisas? 確認",
        tag: "C1",
        renotify: true,
        icon: "https://app.campflare.test/icons/icon-192.png",
        badge: "https://app.campflare.test/icons/badge-96.png",
        data: { route: "#/C1?msg=1.2" },
      },
    })
    await showPush(scope, null)
    expect(shown[1]).toMatchObject({ title: "Campflare", options: { body: "", data: { route: "#/" } } })
    expect(shown[1]!.options.tag).toBeUndefined()
    expect(readPush(null)).toBeNull()
    expect(readPush({ json: () => ({ title: "x" }), text: () => "" })).toEqual({ title: "x" })
    expect(
      readPush({
        json: () => {
          throw new SyntaxError("not json")
        },
        text: () => "plain 안녕",
      }),
    ).toEqual({ body: "plain 안녕" })
  })

  it("on a click, sends an open window of the app to the route, or opens one there", async () => {
    const other = {
      url: "https://elsewhere.test/",
      focus: vi.fn<() => Promise<unknown>>(),
      postMessage: vi.fn<(m: unknown) => void>(),
    }
    const app = {
      url: "https://app.campflare.test/#/C9",
      focus: vi.fn<() => Promise<unknown>>(async () => undefined),
      postMessage: vi.fn<(m: unknown) => void>(),
    }
    const open = fakeScope([other, app])
    await openRoute(open.scope, "#/C1/1.0?msg=2.0")
    expect(app.postMessage).toHaveBeenCalledWith({ type: OPEN_ROUTE, route: "#/C1/1.0?msg=2.0" })
    expect(app.focus).toHaveBeenCalled()
    expect(other.postMessage).not.toHaveBeenCalled()

    const none = fakeScope([other])
    await openRoute(none.scope, "#/C1?msg=2.0")
    expect(none.scope.clients.openWindow).toHaveBeenCalledWith("https://app.campflare.test/#/C1?msg=2.0")
    // Only routes: anything else opens the app's start.
    await openRoute(none.scope, "https://evil.test/")
    expect(none.scope.clients.openWindow).toHaveBeenLastCalledWith("https://app.campflare.test/#/")
  })

  it("is served as a classic script that wires itself up as a service worker", async () => {
    const code = await serviceWorkerSource()
    expect(code).not.toMatch(/^\s*(export|import)\b/m)
    const { scope, shown } = fakeScope()
    const worker = Object.assign(new EventTarget(), scope, {
      skipWaiting: vi.fn<() => Promise<void>>(async () => undefined),
    })
    // eslint-disable-next-line no-new-func -- running the built worker, as the browser would
    new Function("self", code)(worker)
    worker.dispatchEvent(new Event("install"))
    expect(worker.skipWaiting).toHaveBeenCalled()

    const waits: Promise<unknown>[] = []
    const push = Object.assign(new Event("push"), {
      data: { json: () => ({ title: "Zoë", body: "hola", tag: "D1", route: "#/D1?msg=3" }), text: () => "" },
      waitUntil: (p: Promise<unknown>) => waits.push(p),
    })
    worker.dispatchEvent(push)
    await Promise.all(waits)
    expect(shown[0]).toMatchObject({ title: "Zoë", options: { body: "hola", data: { route: "#/D1?msg=3" } } })

    const close = vi.fn<() => void>()
    const click = Object.assign(new Event("notificationclick"), {
      notification: { close, data: { route: "#/D1?msg=3" } },
      waitUntil: (p: Promise<unknown>) => waits.push(p),
    })
    worker.dispatchEvent(click)
    await Promise.all(waits)
    expect(close).toHaveBeenCalled()
    expect(scope.clients.openWindow).toHaveBeenCalledWith("https://app.campflare.test/#/D1?msg=3")
  })

  it("installs the same handlers from the module", async () => {
    const { scope } = fakeScope()
    const worker = Object.assign(new EventTarget(), scope, { skipWaiting: async () => undefined })
    install(worker)
    const waits: Promise<unknown>[] = []
    worker.dispatchEvent(
      Object.assign(new Event("notificationclick"), {
        notification: { close: () => undefined },
        waitUntil: (p: Promise<unknown>) => waits.push(p),
      }),
    )
    await Promise.all(waits)
    expect(scope.clients.openWindow).toHaveBeenCalledWith("https://app.campflare.test/#/")
  })
})

describe("push in the browser", () => {
  it("names the browser and reads keys", () => {
    expect(deviceLabel(FIREFOX_LINUX)).toBe("Firefox on Linux")
    expect(
      deviceLabel(
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15",
      ),
    ).toBe("Safari on macOS")
    expect(
      deviceLabel(
        "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
      ),
    ).toBe("Safari on iOS")
    expect(
      deviceLabel(
        "Mozilla/5.0 (Linux; Android 15) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Mobile Safari/537.36",
      ),
    ).toBe("Chrome on Android")
    expect(
      deviceLabel("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140.0 Safari/537.36 Edg/140.0"),
    ).toBe("Edge on Windows")
    expect(deviceLabel("Mozilla/5.0 (X11; CrOS x86_64) AppleWebKit/537.36 Chrome/140.0 Safari/537.36 OPR/120.0")).toBe(
      "Opera on ChromeOS",
    )
    expect(deviceLabel("curl/8")).toBe("Browser")
    expect(keyBytes(KEY)).toHaveLength(65)
    expect(keyBytes(KEY)[0]).toBe(4)
  })

  it("reads the platform from the browser's globals, and knows the desktop shell has none", () => {
    expect(browserPlatform().push).toBe(false)
    const g = {
      Notification: { permission: "default" },
      PushManager: function PushManager() {},
      navigator: { serviceWorker: {}, userAgent: "iPhone", standalone: true },
    } as unknown as typeof globalThis
    const p = browserPlatform(g)
    expect(p).toMatchObject({ push: true, standalone: true, userAgent: "iPhone" })
    expect(p.serviceWorker).toBeDefined()
    expect(needsInstall(p)).toBe(false)
    expect(needsInstall({ ...p, standalone: false })).toBe(true)
    expect(browserPlatform({ ...g, __TAURI__: {} } as unknown as typeof globalThis).serviceWorker).toBeUndefined()
  })

  it("registers the service worker at the root and follows its open-route messages", async () => {
    const browser = fakeBrowser()
    const routes: string[] = []
    await registerServiceWorker(browser.platform, (r) => routes.push(r))
    expect(browser.platform.serviceWorker!.register).toHaveBeenCalledWith("./sw.js", { scope: "./" })
    browser.message({ type: OPEN_ROUTE, route: "#/C1?msg=1" })
    browser.message({ type: OPEN_ROUTE, route: "javascript:alert(1)" })
    browser.message({ type: "other" })
    browser.message(null)
    expect(routes).toEqual(["#/C1?msg=1"])
    await registerServiceWorker({ ...browser.platform, serviceWorker: undefined }, () => undefined)
  })

  it("turns on: asks first, subscribes with the server's key, and tells the server", async () => {
    const api = pushServer()
    const ws = workspaceOn(api)
    const browser = fakeBrowser()
    expect(await currentPush(ws, browser.platform)).toBe("off")
    expect(await turnOnPush(ws, browser.platform)).toBe("on")
    expect(browser.notification.requestPermission).toHaveBeenCalled()
    expect(browser.registration.pushManager.subscribe).toHaveBeenCalledWith({
      userVisibleOnly: true,
      applicationServerKey: keyBytes(KEY),
    })
    expect(callsTo(api, "campflare.push.subscribe").at(-1)!.args).toEqual({
      subscription: JSON.stringify({
        endpoint: "https://push.example/1",
        keys: { p256dh: "p256dh-1", auth: "auth-1" },
      }),
      label: "Firefox on Linux",
    })
    // Next visit: still on, and the server hears of it again (it may have dropped it).
    expect(await currentPush(ws, browser.platform)).toBe("on")
    expect(callsTo(api, "campflare.push.subscribe")).toHaveLength(2)

    expect(await turnOffPush(ws, browser.platform)).toBe("off")
    expect(browser.current()).toBeNull()
    expect(callsTo(api, "campflare.push.unsubscribe").at(-1)!.args).toEqual({ endpoint: "https://push.example/1" })
    expect(await turnOffPush(ws, browser.platform)).toBe("off")
  })

  it("replaces a subscription made with another key", async () => {
    const api = pushServer()
    const ws = workspaceOn(api)
    const browser = fakeBrowser("granted")
    const stale = browser.existing(OTHER_KEY)
    expect(await currentPush(ws, browser.platform)).toBe("on")
    expect((stale as { unsubscribed?: boolean }).unsubscribed).toBe(true)
    expect(callsTo(api, "campflare.push.unsubscribe")[0]!.args).toEqual({ endpoint: stale.endpoint })
    expect(new Uint8Array(browser.current()!.options.applicationServerKey!)).toEqual(keyBytes(KEY))

    // Turning on over a stale one replaces it too.
    browser.existing(OTHER_KEY)
    expect(await turnOnPush(ws, browser.platform)).toBe("on")
    expect(new Uint8Array(browser.current()!.options.applicationServerKey!)).toEqual(keyBytes(KEY))
  })

  it("says why it can't: unsupported, not configured, blocked, or not granted", async () => {
    const ws = workspaceOn(pushServer())
    const browser = fakeBrowser()
    expect(await currentPush(ws, { ...browser.platform, push: false })).toBe("unsupported")
    expect(await turnOnPush(ws, { ...browser.platform, notification: undefined })).toBe("unsupported")
    expect(await turnOffPush(ws, { ...browser.platform, serviceWorker: undefined })).toBe("unsupported")
    expect(await currentPush(workspaceOn(pushServer(null)), browser.platform)).toBe("unconfigured")
    expect(await turnOnPush(workspaceOn(pushServer(null)), fakeBrowser().platform)).toBe("unconfigured")
    expect(await currentPush(ws, fakeBrowser("denied").platform)).toBe("denied")
    expect(await turnOnPush(ws, fakeBrowser("default", "denied").platform)).toBe("denied")
    expect(await turnOnPush(ws, fakeBrowser("default", "default").platform)).toBe("off")
    // Subscribed once, but the permission was reset since.
    const reset = fakeBrowser("default")
    reset.existing(KEY)
    expect(await currentPush(ws, reset.platform)).toBe("off")
  })
})

describe("telling the server the person is looking", () => {
  it("says active while visible and focused, again every minute, and inactive at once", () => {
    vi.useFakeTimers()
    const said: boolean[] = []
    const doc = Object.assign(new EventTarget(), {
      visibilityState: "visible" as DocumentVisibilityState,
      focused: true,
    })
    const win = new EventTarget()
    const stop = reportActivity(
      { setActive: (a) => said.push(a) },
      Object.assign(doc, { hasFocus: () => doc.focused }),
      win as Window,
    )
    expect(said).toEqual([true])
    vi.advanceTimersByTime(ACTIVE_RESEND_MS)
    expect(said).toEqual([true, true])
    doc.focused = false
    win.dispatchEvent(new Event("blur"))
    vi.advanceTimersByTime(ACTIVE_RESEND_MS * 3)
    expect(said).toEqual([true, true, false])
    doc.focused = true
    win.dispatchEvent(new Event("focus"))
    doc.visibilityState = "hidden"
    doc.dispatchEvent(new Event("visibilitychange"))
    expect(said).toEqual([true, true, false, true, false])
    stop()
    doc.visibilityState = "visible"
    doc.dispatchEvent(new Event("visibilitychange"))
    expect(said).toHaveLength(5)
  })
})

describe("the notifications menu", () => {
  /** The app signed in, in a browser with push (stubbed globals, as the menu reads them). */
  async function signedIn(browser: ReturnType<typeof fakeBrowser> | null, server = fakeServer()) {
    if (browser) {
      vi.stubGlobal("Notification", browser.platform.notification)
      vi.stubGlobal("PushManager", function PushManager() {})
      Object.defineProperty(navigator, "serviceWorker", { value: browser.platform.serviceWorker, configurable: true })
    }
    Object.assign(server.api.handlers, {
      "campflare.push.vapidKey": () => ({ key: KEY }),
      "campflare.push.subscribe": () => ({ subscription: { id: "P1" } }),
      "campflare.push.unsubscribe": () => ({ removed: ["P1"] }),
      "campflare.push.test": () => ({ sent: 2, failed: 0, removed: 0 }),
    })
    const store = browserStore()
    await store.save({ url: "https://x.test", token: "xoxp-1" })
    const user = userEvent.setup()
    render(<App store={store} connect={server.connect} />)
    await screen.findByRole("heading", { name: "general", level: 1 })
    act(() => hello())
    const openMenu = async () => user.click(screen.getByRole("button", { name: /Test Team/ }))
    return { server, user, openMenu }
  }

  afterEach(() => {
    Reflect.deleteProperty(navigator, "serviceWorker")
  })

  it("turns notifications on, sends a test, and turns them off", async () => {
    const browser = fakeBrowser()
    const { server, user, openMenu } = await signedIn(browser)
    await openMenu()
    await user.click(await screen.findByRole("menuitem", { name: "Turn on notifications" }))
    await waitFor(() => expect(server.api.calls.some((c) => c.method === "campflare.push.subscribe")).toBe(true))
    expect(await screen.findByText("Notifications are on in this browser")).toBeTruthy()

    await openMenu()
    await user.click(await screen.findByRole("menuitem", { name: "Send a test notification" }))
    expect(await screen.findByText("Sent a test notification to 2 devices")).toBeTruthy()

    await openMenu()
    await user.click(await screen.findByRole("menuitem", { name: "Turn off notifications" }))
    await waitFor(() => expect(server.api.calls.some((c) => c.method === "campflare.push.unsubscribe")).toBe(true))
    await openMenu()
    expect(await screen.findByRole("menuitem", { name: "Turn on notifications" })).toBeTruthy()
  })

  it("says when the browser blocks them, and reports a failure to turn them on", async () => {
    const blocked = await signedIn(fakeBrowser("denied"))
    await blocked.openMenu()
    expect(await screen.findByText("Notifications are blocked in your browser's settings")).toBeTruthy()
  })

  it("reports a failure to turn them on", async () => {
    const browser = fakeBrowser()
    browser.registration.pushManager.subscribe.mockRejectedValueOnce(
      new DOMException("push service down", "AbortError"),
    )
    const { user, openMenu } = await signedIn(browser)
    await openMenu()
    await user.click(await screen.findByRole("menuitem", { name: "Turn on notifications" }))
    expect(await screen.findByText(/push service down/)).toBeTruthy()
  })

  it("says the browser can't, where there's no Push API", async () => {
    const { openMenu } = await signedIn(null)
    await openMenu()
    expect(await screen.findByText("This browser can't show notifications")).toBeTruthy()
  })
})
