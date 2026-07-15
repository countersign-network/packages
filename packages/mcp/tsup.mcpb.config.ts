import { defineConfig } from "tsup";

// The MCPB (Smithery / desktop-extension) build — unlike the npm build, this one inlines EVERY
// dependency (@countersign/sdk, @modelcontextprotocol/sdk, zod, workspace types) into one file, so
// the .mcpb bundle runs on a bare `node` with no install step. Output feeds `mcpb pack ./mcpb`.
export default defineConfig({
  entry: { "server/index": "src/server.ts" },
  outDir: "mcpb",
  format: ["esm"],
  target: "node20", // MCPB hosts pin conservative Node versions; no node22-only APIs in this tree
  noExternal: [/.*/], // self-contained: bundle everything
  clean: false, // mcpb/ also holds manifest.json — never wipe it
  shims: false,
});
