// Bundle the SELF-CONTAINED .d.ts for the published package. Reads the pre-emitted declarations
// (.dts/, produced by `tsc -p tsconfig.dts.json`) and aliases the @countersign/* type-deps to their
// emitted .d.ts — so rollup-plugin-dts only ever parses declarations (never raw .ts) and inlines the
// referenced types. Result: dist/index.d.ts with zero workspace deps and no brain logic.
import dts from "rollup-plugin-dts";
import alias from "@rollup/plugin-alias";
import path from "node:path";

const here = import.meta.dirname;
const root = path.resolve(here, "..");
const emitted = (p) => path.join(root, ".dts", p);

export default {
  input: emitted("api-contract/index.d.ts"),
  output: { file: path.join(here, "dist/index.d.ts"), format: "es" },
  plugins: [
    alias({
      entries: [
        { find: "@countersign/core", replacement: emitted("packages/core/src/index.d.ts") },
      ],
    }),
    dts(),
  ],
};
