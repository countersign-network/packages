import { defineConfig } from "tsup";

// Library build (ESM + CJS + bundled .d.ts). @countersign/api-contract stays external (a declared
// dep), so consumers resolve its types from npm.
export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm", "cjs"],
  dts: true,
  clean: true,
  target: "es2022",
});
