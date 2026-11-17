import { defineConfig } from "tsdown"

// One entry, ESM + CJS, each with its own .d.ts (.d.mts / .d.cts), for
// Node 18+ and every edge runtime. No dependency is bundled: there are none,
// and the optional `@react-email/render` stays a dynamic import.
export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm", "cjs"],
  platform: "neutral",
  target: "es2022",
  dts: true,
  fixedExtension: true,
  clean: true,
  sourcemap: false,
  deps: { neverBundle: ["@react-email/render"] },
})
