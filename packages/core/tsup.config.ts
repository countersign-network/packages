import { defineConfig } from "tsup";

// JS bundle only; the .d.ts is bundled separately via rollup-plugin-dts (rollup.dts.config.mjs) from
// the emitted declarations. `zod` is the one runtime dependency and stays EXTERNAL (tsup externalizes
// declared deps by default) — consumers share their own zod. No workspace deps, no vendor SDKs, no brain.
export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm", "cjs"],
  dts: false,
  clean: true,
});
