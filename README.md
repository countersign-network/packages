# Countersign

**A neutral, cross-vendor control plane for AI agents that spend money.** Countersign holds the
**policy**, the **freeze**, and the **audit ledger** *across multiple agent-wallet backends at once* —
the one thing no single wallet vendor can do, because each only governs its own rail. That
aggregation is the moat.

[![Countersign — one policy, one sub-second freeze, one signed ledger, across every wallet vendor](https://countersign.network/demo.gif)](https://countersign.network/demo.html)

*Live version of this loop: [countersign.network/demo.html](https://countersign.network/demo.html) · [60s video](https://countersign.network/demo.mp4)*

> One falsifiable test defines it: **can Countersign freeze agents across many backends at once, in
> under a second, with a unified tamper-evident ledger of every attempt?** Proven LIVE across **four
> rails** (Coinbase, Turnkey, Openfort, and a Lithic Visa **card**) in ~432ms on testnet.

This repository is the **open-core front door** — the Apache-2.0 packages you build *against*: the
integration contract, the typed client, the MCP tools, and the x402 guard. The control-plane "brain"
(the policy compiler, the hash-chained ledger, the vendor adapters, and the hosted Core) is separate
and proprietary; you reach it over the network via the SDK/MCP, hosted at **app.countersign.network**.

## Quickstart

**Drop the kill switch + spend guard into any MCP client** (Claude, Cursor, …) — one line:

```jsonc
// claude / cursor mcp config
{ "mcpServers": { "countersign": {
  "command": "npx", "args": ["-y", "@countersign/mcp"],
  "env": { "COUNTERSIGN_URL": "https://app.countersign.network", "COUNTERSIGN_API_KEY": "csk_…" }
}}}
```

**Or wire it into your own agent with the SDK:**

```ts
import { CountersignClient } from "@countersign/sdk";
const cs = new CountersignClient({ baseUrl, apiKey });

await cs.evaluate({ agentId, amount, asset, venue }); // may this spend happen? (allow / deny / needs_approval)
await cs.freeze();                                     // the kill switch — every backend, < 1s
```

Get a free testnet key at **<https://app.countersign.network/start?ref=gh-readme>**.

**Agents paying agents?** See [`examples/guarded-payee`](examples/guarded-payee) — the A2A/AP2
pattern where a payee advertises it is governed and the payer verifies that (and guards its own
payment) before any mandate is signed.

## Packages (this repo — all Apache-2.0)

| Package | Role |
|---|---|
| [`@countersign/core`](packages/core) | the `EnforcementProvider` interface, branded ids, the unified policy **schema**, the fail-closed **freeze controller** — the integration contract every backend implements |
| [`@countersign/api-contract`](api-contract) | OpenAPI + typed REST/ws schema — the single source of truth for the Client↔Core wire interface |
| [`@countersign/sdk`](packages/sdk) | typed client over the Core API + live ledger subscribe |
| [`@countersign/mcp`](packages/mcp) | Countersign as MCP tools — kill switch + spend guard inside any MCP client |
| [`@countersign/x402`](packages/x402) | govern [x402](https://x402.org) (HTTP-402 machine payments) — guard a payment *before* it pays |
| [`@countersign/verify`](packages/verify) | verify a ledger entry offline — hash chain, RFC 6962 Merkle inclusion, Ed25519 signatures |
| [`@countersign/ap2`](packages/ap2) | govern AP2 (Agent Payments Protocol) — guard an agent-payment mandate before it executes |

The proprietary brain (policy **compiler** to each backend's native controls, ledger, Coinbase /
Turnkey / Openfort / Lithic adapters, the hosted Core) lives in a separate private repository.

## Prime directives (invariants)

1. Don't build cryptography — integrate vendor MPC/TEE; session keys, never master keys.
2. Build the layer **above** the wallets; cross-vendor aggregation is the product.
3. **Fail-closed**: no decision / no backend response ⇒ the transaction does **not** execute.
4. Backend-agnostic core; no vendor logic leaks past the `EnforcementProvider` interface.
5. Append-only, hash-chained ledger is the source of truth.
6. Testnet only — mainnet follows a third-party security audit.

## Links

- **Home:** <https://countersign.network> · **Hosted Core:** <https://app.countersign.network>
- **npm:** [`@countersign/sdk`](https://www.npmjs.com/package/@countersign/sdk) ·
  [`@countersign/mcp`](https://www.npmjs.com/package/@countersign/mcp) ·
  [`@countersign/x402`](https://www.npmjs.com/package/@countersign/x402) ·
  [`@countersign/ap2`](https://www.npmjs.com/package/@countersign/ap2)
- **Architecture:** [`docs/architecture.md`](docs/architecture.md) · **Security:** [`SECURITY.md`](SECURITY.md)

Apache-2.0. Countersign holds policy, freeze, and a tamper-evident ledger — it never takes custody of funds.
