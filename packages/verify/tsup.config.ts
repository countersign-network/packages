import { defineConfig } from "tsup";

// Library (ESM + CJS + bundled .d.ts) + the CLI bin (ESM with a shebang). Node-builtin-only —
// verification must carry zero third-party dependencies a skeptic would have to audit.
export default defineConfig([
  {
    entry: ["src/index.ts"],
    format: ["esm", "cjs"],
    dts: true,
    clean: true,
    target: "es2022",
  },
  {
    entry: ["src/cli.ts"],
    format: ["esm"],
    target: "es2022",
  },
]);
