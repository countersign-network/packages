import { defineConfig } from "tsup";

// Builds the runnable stdio server (the bin) + the tools export. Runtime deps (@countersign/sdk,
// @modelcontextprotocol/sdk, zod) stay external — npm installs them. The shebang in server.ts is
// preserved so `npx @countersign/mcp` runs directly.
export default defineConfig({
  entry: ["src/server.ts", "src/index.ts"],
  format: ["esm"],
  target: "node22",
  clean: true,
  shims: false,
});
