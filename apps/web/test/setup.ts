import { cleanup } from "@testing-library/react"
import { afterEach } from "vitest"

// vite.config.ts defines it for the app; tests sign in explicitly.
;(globalThis as { __CAMPFLARE_DEV__?: unknown }).__CAMPFLARE_DEV__ = null

/**
 * happy-dom's IntersectionObserver never reports anything. This one reports each observed
 * element in view at once, so lazily loaded images load; `ViewportObserver.manual` holds
 * reports back until a test calls `ViewportObserver.show(element)`.
 */
export class ViewportObserver {
  static manual = false
  static all = new Set<ViewportObserver>()
  readonly targets = new Set<Element>()
  constructor(private readonly callback: IntersectionObserverCallback) {}
  observe(target: Element) {
    this.targets.add(target)
    ViewportObserver.all.add(this)
    if (!ViewportObserver.manual) queueMicrotask(() => this.report(target, true))
  }
  unobserve(target: Element) {
    this.targets.delete(target)
  }
  disconnect() {
    this.targets.clear()
    ViewportObserver.all.delete(this)
  }
  takeRecords() {
    return []
  }
  report(target: Element, isIntersecting: boolean) {
    if (!this.targets.has(target)) return
    const entry = { target, isIntersecting } as IntersectionObserverEntry
    this.callback([entry], this as unknown as IntersectionObserver)
  }
  /** Reports the element as scrolled into view (or out of it) to whoever observes it. */
  static show(target: Element, isIntersecting = true) {
    for (const observer of ViewportObserver.all) observer.report(target, isIntersecting)
  }
}
globalThis.IntersectionObserver = ViewportObserver as unknown as typeof IntersectionObserver

afterEach(() => {
  cleanup()
  window.location.hash = ""
  ViewportObserver.manual = false
  ViewportObserver.all.clear()
})
