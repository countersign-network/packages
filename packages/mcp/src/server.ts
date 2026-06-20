#!/usr/bin/env -S npx tsx
/**
 * The runnable Cosign MCP server (stdio). Point it at a running Core and drop it into any MCP client.
 *
 *   # 1. start the Core (mock fleet + dashboard):
 *   pnpm --filter @cosign/api start
 *   # 2. register this server in your MCP client (e.g. Claude Desktop), e.g.:
 *   #    { "command": "pnpm", "args": ["--filter","@cosign/mcp","start"], "env": { "COSIGN_URL": "http://localhost:8080" } }
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CosignClient } from "@cosign/sdk";
import { createCosignTools } from "./tools";

const baseUrl = process.env["COSIGN_URL"] ?? "http://localhost:8080";
const client = new CosignClient({ baseUrl });

const server = new McpServer({ name: "cosign", version: "0.1.0" });

for (const t of createCosignTools(client)) {
  server.tool(t.name, t.description, t.schema, async (args: Record<string, unknown>) => ({
    content: [{ type: "text" as const, text: await t.handler(args) }],
  }));
}

await server.connect(new StdioServerTransport());
console.error(`cosign-mcp connected (Core: ${baseUrl})`);
