import { defineConfig } from "tsup";

// JS bundle only; dts is bundled separately via rollup-plugin-dts (rollup.dts.config.mjs) from the
// emitted declarations. @countersign/api-contract stays EXTERNAL — it's a published runtime dep, not
// inlined (so no duplication, and consumers share one contract package).
export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm", "cjs"],
  dts: false,
  clean: true,
});
