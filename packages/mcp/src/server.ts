#!/usr/bin/env -S npx tsx
/**
 * The runnable Cosign MCP server (stdio). Drop it into any MCP client (Claude Desktop/Code, …).
 *
 * Two modes, zero-config by default:
 *   - EMBEDDED (default): no env needed. Spins up an in-process Core over the mock fleet — one
 *     command, no separate server, no credentials. Great for "try it in 60 seconds".
 *       { "command": "pnpm", "args": ["--filter", "@cosign/mcp", "start"] }
 *   - REMOTE: set COSIGN_URL to govern a real running Core (your hosted/self-hosted control plane).
 *       env: { "COSIGN_URL": "https://core.your-cosign.example" }
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CosignClient } from "@cosign/sdk";
import { createDemoCore, createLocalApi } from "@cosign/api";
import type { CosignApi } from "@cosign/api-contract";
import { createCosignTools } from "./tools";

const remote = process.env["COSIGN_URL"];
let api: CosignApi;
let mode: string;
if (remote) {
  api = new CosignClient({ baseUrl: remote });
  mode = `remote Core ${remote}`;
} else {
  const { core } = await createDemoCore();
  api = createLocalApi(core);
  mode = "embedded Core (mock fleet — no setup, no credentials)";
}

const server = new McpServer({ name: "cosign", version: "0.1.0" });
for (const t of createCosignTools(api)) {
  server.tool(t.name, t.description, t.schema, async (args: Record<string, unknown>) => ({
    content: [{ type: "text" as const, text: await t.handler(args) }],
  }));
}

await server.connect(new StdioServerTransport());
console.error(`cosign-mcp connected — ${mode}`);
