#!/usr/bin/env node
/**
 * Countersign MCP server (stdio) — the cross-vendor kill switch + spend guard as tools inside any
 * MCP client (Claude Desktop/Code, Cursor, …). It governs a running Countersign Core; no keys or
 * crypto live here. Configure via env:
 *
 *   COUNTERSIGN_URL       (required)  your Core, e.g. https://app.countersign.network
 *   COUNTERSIGN_API_KEY   (required when the Core has auth enabled)
 *
 * Example MCP client config:
 *   { "command": "npx", "args": ["-y", "@countersign/mcp"],
 *     "env": { "COUNTERSIGN_URL": "https://app.countersign.network", "COUNTERSIGN_API_KEY": "csk_…" } }
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CountersignClient } from "@countersign/sdk";
import { createCountersignTools } from "./tools";

const baseUrl = process.env["COUNTERSIGN_URL"];
if (!baseUrl) {
  console.error(
    "countersign-mcp: set COUNTERSIGN_URL to your Countersign Core (e.g. https://app.countersign.network),\n" +
      "and COUNTERSIGN_API_KEY if it requires auth. See https://countersign.network.",
  );
  process.exit(1);
}
const apiKey = process.env["COUNTERSIGN_API_KEY"];
const client = new CountersignClient({ baseUrl, ...(apiKey ? { apiKey } : {}) });

const server = new McpServer({ name: "countersign", version: "0.2.0" });
for (const t of createCountersignTools(client)) {
  server.tool(t.name, t.description, t.schema, async (args: Record<string, unknown>) => ({
    content: [{ type: "text" as const, text: await t.handler(args) }],
  }));
}

await server.connect(new StdioServerTransport());
console.error(`countersign-mcp connected → ${baseUrl}${apiKey ? " (authenticated)" : ""}`);
