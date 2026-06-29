// Bundle the SELF-CONTAINED .d.ts from the pre-emitted declarations (../../.dts, produced by
// `tsc -p ../../tsconfig.dts.json`). core has no @countersign workspace deps; `zod` is left EXTERNAL
// so the published .d.ts keeps `from "zod"` and resolves via the runtime dependency (no inlining).
import dts from "rollup-plugin-dts";
import path from "node:path";

const here = import.meta.dirname;
const emitted = path.resolve(here, "../..", ".dts/packages/core/src/index.d.ts");

export default {
  input: emitted,
  output: { file: path.join(here, "dist/index.d.ts"), format: "es" },
  external: [/^@countersign\//, "zod"],
  plugins: [dts()],
};
