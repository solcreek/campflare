import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    // A real server: wrangler dev with fresh local D1, R2 and Durable Objects.
    globalSetup: ["../../tests/conformance/global-setup.ts"],
    testTimeout: 20_000,
    hookTimeout: 60_000,
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/index.ts"],
      thresholds: { lines: 90, functions: 90, branches: 80, statements: 90 },
    },
  },
})
