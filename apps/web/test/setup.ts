import { cleanup } from "@testing-library/react"
import { afterEach } from "vitest"

// vite.config.ts defines it for the app; tests sign in explicitly.
;(globalThis as { __CAMPFLARE_DEV__?: unknown }).__CAMPFLARE_DEV__ = null

afterEach(() => {
  cleanup()
  window.location.hash = ""
})
