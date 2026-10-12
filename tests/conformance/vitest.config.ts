import { fileURLToPath } from "node:url"
import { defineConfig } from "vitest/config"

const source = (path: string) => fileURLToPath(new URL(path, import.meta.url))

export default defineConfig({
  // Our own packages from source, not builds that may be stale.
  resolve: {
    alias: {
      "@campflare/client": source("../../packages/client/src/index.ts"),
      "@campflare/core": source("../../packages/core/src/index.ts"),
    },
  },
  test: {
    globalSetup: ["./global-setup.ts"],
    testTimeout: 20_000,
    hookTimeout: 60_000,
  },
})
