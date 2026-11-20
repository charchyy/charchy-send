import { defineConfig } from "tsdown"

// Two entries — the SDK and `@charchy/send/hono` — ESM + CJS, each with its
// own .d.ts (.d.mts / .d.cts), for Node 18+ and every edge runtime. No
// dependency is bundled: the optional `@react-email/render` stays a dynamic
// import, and `hono` is only ever a type import (the root entry never
// reaches the hono entry; shared code goes in a common chunk).
export default defineConfig({
  entry: ["src/index.ts", "src/hono.ts"],
  format: ["esm", "cjs"],
  platform: "neutral",
  target: "es2022",
  dts: true,
  fixedExtension: true,
  clean: true,
  sourcemap: false,
  deps: { neverBundle: ["@react-email/render", "hono"] },
})
