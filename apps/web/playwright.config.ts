import { defineConfig } from "@playwright/test"

// pnpm --filter @campflare/web e2e: the app in Chromium against a fresh local
// stack (e2e/global-setup.ts). Needs nothing running.

export default defineConfig({
  testDir: "e2e",
  globalSetup: "./e2e/global-setup.ts",
  // One stack, shared: tests run one at a time and make their own channels.
  workers: 1,
  timeout: 30_000,
  expect: { timeout: 10_000 },
  reporter: process.env.CI ? "github" : "list",
  use: { trace: "retain-on-failure", screenshot: "only-on-failure" },
  outputDir: ".shots/e2e",
})
