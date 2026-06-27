import { defineConfig } from "tsup";

// Bundle the contract into a SELF-CONTAINED package: inline the @countersign/* type-deps (resolve:true
// for the .d.ts) so the published package has zero workspace deps and pulls in no brain code — it is
// only types + the OpenAPI spec + the ws path constant.
export default defineConfig({
  entry: ["index.ts"],
  format: ["esm", "cjs"],
  dts: false, // dts is bundled separately via rollup-plugin-dts (rollup.dts.config.mjs) from emitted .d.ts
  clean: true,
  noExternal: [/^@countersign\//],
});
