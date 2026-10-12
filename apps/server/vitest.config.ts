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
            // Huddles call the Realtime SFU and transcription calls Workers AI, both faked in the
            // tests (setSfuFetch, setSpeechFetch, setSummaryFetch): any credentials will do, and
            // the suite mustn't depend on a .dev.vars that CI doesn't have.
            REALTIME_APP_ID: "test-realtime-app",
            REALTIME_APP_SECRET: "test-realtime-secret",
            CF_ACCOUNT_ID: "test-account",
            WORKERS_AI_TOKEN: "test-workers-ai-token",
          },
        },
      }),
    ],
    test: {
      setupFiles: ["./test/setup.ts"],
      // The bulk tests (a full history page, search across pages) take ~1 s alone but
      // passed 5 s when other worktrees ran workerd on the same machine. A hang still fails.
      testTimeout: 20_000,
      coverage: {
        provider: "istanbul" as const,
        include: ["src/**/*.ts"],
        reporter: ["text", "html", "json-summary"],
        thresholds: { lines: 95, functions: 95, branches: 85, statements: 95 },
      },
    },
  }
})
