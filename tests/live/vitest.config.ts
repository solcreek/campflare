import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    // A real server too: wrangler dev with fresh local state, and the Realtime
    // credentials from apps/server/.dev.vars.
    globalSetup: ["../conformance/global-setup.ts"],
    testTimeout: 90_000,
    hookTimeout: 90_000,
  },
})
