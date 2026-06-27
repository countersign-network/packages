// Bundle the SELF-CONTAINED .d.ts from the pre-emitted declarations (../../.dts, produced by
// `tsc -p ../../tsconfig.dts.json`). @countersign/api-contract is left EXTERNAL — it's a published
// runtime dependency, so the published .d.ts keeps `from "@countersign/api-contract"` and resolves
// via the dep (no inlining, no brain).
import dts from "rollup-plugin-dts";
import path from "node:path";

const here = import.meta.dirname;
const emitted = path.resolve(here, "../..", ".dts/packages/sdk/src/index.d.ts");

export default {
  input: emitted,
  output: { file: path.join(here, "dist/index.d.ts"), format: "es" },
  external: [/^@countersign\//],
  plugins: [dts()],
};
