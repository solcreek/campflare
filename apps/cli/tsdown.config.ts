import { defineConfig } from "tsdown"

// One self-contained file: the client library is bundled in, so the CLI has
// no runtime dependencies.
export default defineConfig({
  entry: ["src/index.ts"],
  format: "esm",
  platform: "node",
  target: "node22",
  noExternal: ["@campflare/client"],
  dts: false,
})
