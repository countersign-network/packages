# @countersign/mcp

[![npm version](https://img.shields.io/npm/v/@countersign/mcp?color=58e6a8&labelColor=0b1020)](https://www.npmjs.com/package/@countersign/mcp)
[![MCP](https://img.shields.io/badge/Model%20Context%20Protocol-server-7c9cff?labelColor=0b1020)](https://modelcontextprotocol.io)
[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-58e6a8?labelColor=0b1020)](./LICENSE)
[![Spending governed by Countersign](https://img.shields.io/badge/spending%20governed%20by-Countersign-58e6a8?labelColor=0b1020)](https://countersign.network)

**The cross-vendor kill switch + spend guard for AI agents — as MCP tools, inside any MCP client.**

[Countersign](https://countersign.network) is a neutral control plane that holds one policy, one
freeze, and one tamper-evident audit ledger across every agent-wallet backend at once. This package
exposes it as [Model Context Protocol](https://modelcontextprotocol.io) tools, so an agent (or you,
from chat in Claude / Cursor) can ask *"may I spend this?"* before acting — and freeze everything in
under a second.

## Tools

| Tool | What it does |
|---|---|
| `countersign_request_spend` | **Pre-flight guard** — ask whether a spend is allowed *before* touching the wallet (allow / deny / needs_approval). |
| `countersign_freeze` | **The kill switch** — freeze every agent on every backend at once. |
| `countersign_apply_policy` | Apply one unified policy (caps, allow/deny lists, approval threshold) across all backends. |
| `countersign_list_agents` / `countersign_health` | See the governed fleet + control-plane health. |
| `countersign_list_approvals` / `countersign_approve` / `countersign_deny` | The human-approval queue. |
| `countersign_ledger` | Read + re-verify the append-only, hash-chained audit ledger. |
| `countersign_unfreeze` | Lift a freeze (recover). |

## Setup

It governs a running Countersign **Core** (hosted at `app.countersign.network`, or self-hosted). Set:

- `COUNTERSIGN_URL` — your Core, e.g. `https://app.countersign.network`
- `COUNTERSIGN_API_KEY` — required when the Core has auth enabled

### Claude Desktop / Claude Code / Cursor

Add to your MCP config (`claude_desktop_config.json`, or `claude mcp add`, or Cursor's `mcp.json`):

```json
{
  "mcpServers": {
    "countersign": {
      "command": "npx",
      "args": ["-y", "@countersign/mcp"],
      "env": {
        "COUNTERSIGN_URL": "https://app.countersign.network",
        "COUNTERSIGN_API_KEY": "csk_…"
      }
    }
  }
}
```

That's it — your agent now has the spend guard and the kill switch.

## Show it (the "powered by" badge)

If Countersign guards your agent, say so — it tells users (and other agents) that spending is governed,
and points the next operator at the same kill switch. Drop this in your README:

```markdown
[![Spending governed by Countersign](https://img.shields.io/badge/spending%20governed%20by-Countersign-58e6a8?labelColor=0b1020)](https://countersign.network)
```

## Listing in MCP registries (distribution)

Countersign spreads by being easy to discover wherever agent builders look for tools. The metadata below
is ready to submit to the common registries — copy it as-is.

- **Official MCP registry** (`registry.modelcontextprotocol.io` / the `mcp-registry` repo) — entry:
  ```json
  {
    "name": "io.github.countersign-network/countersign",
    "description": "Cross-vendor kill switch + spend guard for AI agents that spend money — one policy, one freeze, one tamper-evident ledger across every wallet/card backend.",
    "homepage": "https://countersign.network",
    "repository": "https://github.com/countersign-network/countersign",
    "packages": [
      { "registry": "npm", "name": "@countersign/mcp", "runtime": "npx" }
    ],
    "license": "Apache-2.0"
  }
  ```
- **[mcp.so](https://mcp.so)** — submit `@countersign/mcp`; category *Finance / Security / Agents*.
- **[Smithery](https://smithery.ai)** — `npx`-launched server; env `COUNTERSIGN_URL` (default `https://app.countersign.network`) + optional `COUNTERSIGN_API_KEY`.
- **awesome-mcp-servers** lists — one-liner:
  > **[Countersign](https://github.com/countersign-network/countersign)** — cross-vendor spend guard + sub-second kill switch + tamper-evident ledger for AI agents that move money (Coinbase, Turnkey, Openfort, Visa card). Testnet.

Standard listing fields:

| Field | Value |
|---|---|
| Server id | `countersign` |
| Launch | `npx -y @countersign/mcp` |
| Tools | `countersign_request_spend`, `countersign_freeze`, `countersign_apply_policy`, `countersign_list_agents`, `countersign_health`, `countersign_list_approvals`, `countersign_approve`, `countersign_deny`, `countersign_ledger`, `countersign_unfreeze` |
| Tags | `payments` · `security` · `kill-switch` · `spend-guard` · `agent-payments` · `wallet` |

> Nothing here is auto-submitted — listings are made deliberately by a maintainer.

Apache-2.0. Countersign holds policy/freeze/ledger; it never takes custody of funds. Testnet only.
