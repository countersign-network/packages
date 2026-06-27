# @countersign/mcp

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

Apache-2.0. Countersign holds policy/freeze/ledger; it never takes custody of funds.
