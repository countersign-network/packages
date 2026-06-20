# Cosign

**A neutral, cross-vendor control plane for AI agents that spend money.** Cosign holds the
**policy**, the **freeze**, and the **audit ledger** *across multiple agent-wallet backends at
once* — the one thing no single wallet vendor can do, because each only governs its own rail. That
aggregation is the moat.

> The one falsifiable test that defines v1: **can Cosign freeze agents across three vendors at once,
> in under a second, with a unified tamper-evident ledger of every attempt?** This repo answers yes —
> runnable and tested today against faithful mocks, with real adapter skeletons ready for credentials.

```
pnpm install
pnpm demo        # 3 agents / 3 backends / 3 venues — one freeze < 1s, fully audited
pnpm typecheck   # strict TS across the workspace
pnpm test        # 62 tests: compiler, hash-chain (+pglite), fail-closed matrix, <1s SLO, REST+ws
```

## What `pnpm demo` shows

1. **One** unified policy compiled to **each backend's native controls** (the compiler — core IP),
   including the fields each backend *can't* enforce natively and Cosign therefore enforces itself.
2. Three reference agents spending: **allowed** within policy; **blocked** on per-tx cap, allowlist,
   and rolling daily cap; **held for human approval** above a threshold.
3. **The kill switch** — one freeze stops all three backends concurrently in well under a second.
4. The **unified, hash-chained ledger** of every attempt, re-verified intact.
5. **Fail-closed under chaos** — a backend whose freeze won't confirm is escalated (revokeSession),
   never reported as safe.

## Architecture

A TypeScript **Core** (the brain) that a thin **Flutter client** talks to. All crypto/SDK weight
lives in Core; the client holds no keys. The language boundary is the trust boundary.

| Package | Role |
|---|---|
| `packages/core` | `EnforcementProvider` interface, branded ids, the fail-closed **freeze controller** |
| `packages/policy` | unified policy (zod) + the **compiler** to each backend's native controls — *core IP* |
| `packages/ledger` | append-only, **hash-chained** store (`LedgerPort` + in-memory + pglite adapters) |
| `packages/providers/mock` | faithful, credential-free backend simulating all 3 enforcement modes |
| `packages/providers/{coinbase,turnkey,openfort}` | real adapter **skeletons** (see *Status*) |
| `packages/api` | the Core service: REST + ws (`packages/api/src/main.ts` runs it) |
| `packages/agent-harness` | reference agents + the headline demo (`pnpm demo`) |
| `packages/sdk` | `@cosign/sdk` — typed client + live ledger subscribe (the front door; roadmap Tier 0 #4) |
| `packages/mcp` | `@cosign/mcp` — Cosign as MCP tools: kill switch + spend guard inside any MCP client (Claude, …) |
| `packages/x402` | `@cosign/x402` — govern x402 (the HTTP-402 machine-payment rail): guard a payment before it pays |
| `api-contract/` | OpenAPI + typed ws schema — single source of truth; generates the Dart client |
| `client/` | Flutter app (scaffold; Phase 3) |

The three `EnforcementMode`s map one-to-one onto the chosen backends:
`native-session-caps` → Coinbase · `pre-sign-policy` → Turnkey · `onchain-policy` → Openfort.

## Prime directives (invariants — see `CLAUDE.md`)

1. Don't build cryptography — integrate vendor MPC/TEE; session keys, never master keys.
2. Build the layer **above** the wallets; aggregation is the product.
3. **Fail-closed**: no decision / no backend response ⇒ the transaction does **not** execute.
4. Backend-agnostic core; no vendor logic leaks past the `EnforcementProvider` interface.
5. Append-only, hash-chained ledger is the source of truth.
6. Testnet only.

## Status (v1 / 90-day proof)

- **Done, credential-free & tested (75 tests):** core + freeze controller, policy compiler,
  hash-chained ledger, MockProvider, REST+ws API + web dashboard, the agent pre-flight **spend
  guard** (`POST /evaluate`), typed **SDK** + **MCP server** (zero-config embedded mode — one
  command, no creds), **x402 governance**, agent harness, demo.
- **Skeletons (need vendor creds):** `packages/providers/{coinbase,turnkey,openfort}` — accurate
  signatures + real `capabilities()`, every live call throws `NotImplementedError`. To finish one:
  install its SDK, fill the methods per `docs/sdk-research/<vendor>.md`, supply credentials.
- **Deferred:** Flutter client beyond scaffold, FCM/APNs push, anomaly detection, Postgres via
  testcontainers (pglite stands in for tests).

## Roadmap & next steps

`docs/NEXT-STEPS.md` (morning checklist) · `docs/moat-and-integration-roadmap.md` (moat + Tier 0–4
integration order). The build is roadmap **Tier 0** (three enforcement backends + the SDK front
door + freeze/policy/ledger), proven against mocks.

## Next (the §7 decisions are yours — see `docs/handoff.md`)

Confirm the three backends + venues, get sandbox credentials, then finish one adapter and re-run the
demo against a live testnet wallet. Defaults assumed for the build: Coinbase + Turnkey + Openfort on
Base Sepolia / Ethereum Sepolia / Polygon Amoy, testnet only.
