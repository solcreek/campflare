import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    globalSetup: ["./global-setup.ts"],
    testTimeout: 20_000,
    hookTimeout: 60_000,
  },
})
