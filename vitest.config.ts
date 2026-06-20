import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/**/test/**/*.test.ts", "packages/**/src/**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/dist/**", "client/**"],
    // The <1s freeze SLO and tamper tests are CPU-light but timing-sensitive;
    // keep a generous hook timeout for the pglite WASM cold start.
    testTimeout: 15_000,
    hookTimeout: 30_000,
  },
});
