#!/usr/bin/env -S npx tsx
/**
 * The runnable Countersign MCP server (stdio). Drop it into any MCP client (Claude Desktop/Code, …).
 *
 * Two modes, zero-config by default:
 *   - EMBEDDED (default): no env needed. Spins up an in-process Core over the mock fleet — one
 *     command, no separate server, no credentials. Great for "try it in 60 seconds".
 *       { "command": "pnpm", "args": ["--filter", "@countersign/mcp", "start"] }
 *   - REMOTE: set COUNTERSIGN_URL to govern a real running Core (your hosted/self-hosted control plane).
 *       env: { "COUNTERSIGN_URL": "https://core.your-countersign.example" }
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CountersignClient } from "@countersign/sdk";
import { createDemoCore, createLocalApi } from "@countersign/api";
import type { CountersignApi } from "@countersign/api-contract";
import { createCountersignTools } from "./tools";

const remote = process.env["COUNTERSIGN_URL"];
let api: CountersignApi;
let mode: string;
if (remote) {
  api = new CountersignClient({ baseUrl: remote });
  mode = `remote Core ${remote}`;
} else {
  const { core } = await createDemoCore();
  api = createLocalApi(core);
  mode = "embedded Core (mock fleet — no setup, no credentials)";
}

const server = new McpServer({ name: "countersign", version: "0.1.0" });
for (const t of createCountersignTools(api)) {
  server.tool(t.name, t.description, t.schema, async (args: Record<string, unknown>) => ({
    content: [{ type: "text" as const, text: await t.handler(args) }],
  }));
}

await server.connect(new StdioServerTransport());
console.error(`countersign-mcp connected — ${mode}`);
