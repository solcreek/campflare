import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers"
import { defineConfig } from "vitest/config"

export default defineConfig(async () => {
  const migrations = await readD1Migrations("./migrations")
  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: "./wrangler.jsonc" },
        miniflare: {
          bindings: {
            TEST_MIGRATIONS: migrations,
            SIGNING_KEY: "test-signing-key",
            BOOTSTRAP_SECRET: "test-bootstrap",
          },
        },
      }),
    ],
    test: {
      setupFiles: ["./test/setup.ts"],
      coverage: {
        provider: "istanbul" as const,
        include: ["src/**/*.ts"],
        reporter: ["text", "html", "json-summary"],
        thresholds: { lines: 90, functions: 90, branches: 75, statements: 90 },
      },
    },
  }
})
