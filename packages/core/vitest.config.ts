import { fileURLToPath } from "node:url"
import { defineConfig } from "vitest/config"

export default defineConfig({
  // Test against the client's source, not a build that may be stale.
  resolve: {
    alias: { "@campflare/client": fileURLToPath(new URL("../client/src/index.ts", import.meta.url)) },
  },
  test: {
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/index.ts", "src/types.ts", "src/testing.ts"],
      thresholds: { lines: 95, functions: 95, branches: 85, statements: 95 },
    },
  },
})
