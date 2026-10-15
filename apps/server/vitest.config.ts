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
            // Where permalinks send the browser; a query of its own, which the redirect keeps.
            APP_URL: "https://app.campflare.test/?team=dev",
            // Web Push: a key pair made for the tests (push services are faked with setPushFetch).
            VAPID_PUBLIC_KEY: "BJQiCS-kDdMSnJJm-oewJ2ESIFX-sq5HFIE2TXDesZbHULYpnrUjid9rwNDjDehUKIZ8G_x_JsIRQA8jDTw20aA",
            VAPID_PRIVATE_KEY: "7dyzr08oHg1CxK68ptek_5k4dxYlkMOk5w3GDpCH8n8",
            VAPID_SUBJECT: "mailto:push@campflare.test",
            // The fake push services' hosts (push.example, fcm.example…).
            PUSH_SERVICE_HOSTS: "*.example",
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
