# Countersign

**A neutral, cross-vendor control plane for AI agents that spend money.** Countersign holds the
**policy**, the **freeze**, and the **audit ledger** *across multiple agent-wallet backends at
once* — the one thing no single wallet vendor can do, because each only governs its own rail. That
aggregation is the moat.

> The one falsifiable test that defines v1: **can Countersign freeze agents across many backends at once,
> in under a second, with a unified tamper-evident ledger of every attempt?** This repo answers yes —
> proven LIVE across **four rails** (Coinbase, Turnkey, Openfort, and a Lithic Visa **card**) in ~432ms
> on testnet, on top of a fully runnable, credential-free mock suite.

```
pnpm install
pnpm demo        # 3 agents / 3 backends / 3 venues — one freeze < 1s, fully audited
pnpm typecheck   # strict TS across the workspace
pnpm test        # 115 tests: compiler + injection-defense, signed hash-chain + append-only, fail-closed matrix, <1s SLO, auth/RBAC, multi-tenancy, MCP, x402, anomaly
```

## What `pnpm demo` shows

1. **One** unified policy compiled to **each backend's native controls** (the compiler — core IP),
   including the fields each backend *can't* enforce natively and Countersign therefore enforces itself.
2. Three reference agents spending: **allowed** within policy; **blocked** on per-tx cap, allowlist,
   and rolling daily cap; **held for human approval** above a threshold.
3. **The kill switch** — one freeze stops all three backends concurrently in well under a second.
4. The **unified, hash-chained ledger** of every attempt, re-verified intact.
5. **Fail-closed under chaos** — a backend whose freeze won't confirm is escalated (revokeSession),
   never reported as safe.

## Architecture

A TypeScript **Core** (the brain) that a thin **Flutter client** talks to. All crypto/SDK weight
lives in Core; the client holds no keys. The language boundary is the trust boundary.

**Diagrams:** see [`docs/architecture.md`](docs/architecture.md) — system overview + the spend-guard
and cross-vendor-freeze flows (Mermaid, renders on GitHub).

**Security:** [`docs/THREAT-MODEL.md`](docs/THREAT-MODEL.md) + [`SECURITY.md`](SECURITY.md) — assets,
trust boundaries, invariants. API auth via `COUNTERSIGN_API_KEYS` (Bearer key → tenant); secrets scanned
in CI (gitleaks).

| Package | Role |
|---|---|
| `packages/core` | `EnforcementProvider` interface, branded ids, the fail-closed **freeze controller** |
| `packages/policy` | unified policy (zod) + the **compiler** to each backend's native controls — *core IP* |
| `packages/ledger` | append-only, **hash-chained** store (`LedgerPort` + in-memory + pglite adapters) |
| `packages/providers/mock` | faithful, credential-free backend simulating all 3 enforcement modes |
| `packages/providers/{coinbase,turnkey,openfort}` | **LIVE** crypto-rail adapters (testnet) |
| `packages/providers/lithic` | **LIVE** non-crypto rail — a virtual Visa **card** (testnet sandbox) |
| `packages/api` | the Core service: REST + ws (`packages/api/src/main.ts` runs it) |
| `packages/agent-harness` | reference agents + the headline demo (`pnpm demo`) |
| `packages/sdk` | `@countersign/sdk` — typed client + live ledger subscribe (the front door; roadmap Tier 0 #4) |
| `packages/mcp` | `@countersign/mcp` — Countersign as MCP tools: kill switch + spend guard inside any MCP client (Claude, …) |
| `packages/x402` | `@countersign/x402` — govern x402 (the HTTP-402 machine-payment rail): guard a payment before it pays |
| `api-contract/` | OpenAPI + typed ws schema — single source of truth; generates the Dart client |
| `client/` | Flutter app (scaffold; Phase 3) |

The three `EnforcementMode`s map one-to-one onto the chosen backends:
`native-session-caps` → Coinbase + Lithic (card) · `pre-sign-policy` → Turnkey · `onchain-policy` → Openfort.

## Prime directives (invariants)

1. Don't build cryptography — integrate vendor MPC/TEE; session keys, never master keys.
2. Build the layer **above** the wallets; aggregation is the product.
3. **Fail-closed**: no decision / no backend response ⇒ the transaction does **not** execute.
4. Backend-agnostic core; no vendor logic leaks past the `EnforcementProvider` interface.
5. Append-only, hash-chained ledger is the source of truth.
6. Testnet only.

## Status (v1 / 90-day proof)

- **Done, credential-free & tested (115 tests):** core + freeze controller, policy compiler
  (+ injection-defense), hash-chained + Ed25519-signed ledger (DB append-only trigger + on-chain
  anchor), MockProvider, REST+ws API + web dashboard, the agent pre-flight **spend guard**
  (`POST /evaluate`) + **human-in-the-loop approval workflow** (fail-closed), typed **SDK** +
  **MCP server** (zero-config embedded mode), **x402 governance**, **anomaly-freeze v0**, agent
  harness, demo.
- **ALL FOUR RAILS LIVE on testnet:** Coinbase (Base Sepolia, native MPC caps), Turnkey
  (in-enclave CEL), Openfort (backend wallet), and **Lithic** — a virtual Visa **card** (the first
  non-crypto rail). Each has `smoke.ts` + `spike.ts` proving real enforcement (in-policy allowed,
  over-cap / frozen declined). 🏁 **Four-rail freeze proven** in ~432ms via
  `packages/agent-harness/live-freeze.ts` — one action, crypto wallets **and** a card; signed ledger verified.
- **Hardening done:** DB-level append-only trigger, on-chain external anchor (every freeze
  countersigns the ledger), input validation + hex-address policy-injection defense, fail-closed
  Coinbase freeze + fail-closed boot. Next: native-enforcement parity (Openfort on-chain guard,
  Turnkey consensus, Lithic ASA), webhook event streams, third-party audit before mainnet.
- **Deferred:** Flutter client beyond scaffold, FCM/APNs push.

## Roadmap & next steps

`docs/NEXT-STEPS.md` (checklist) · `docs/moat-and-integration-roadmap.md` (moat + Tier 0–4 integration
order) · `docs/pricing-and-gtm.md` (pricing + growth). The build is roadmap **Tier 0** (three
enforcement backends + the SDK/MCP front door + freeze/policy/ledger/guard/anomaly), proven against mocks.

## Next (the §7 decisions are yours — see `docs/handoff.md`)

Confirm the three backends + venues, get sandbox credentials, then finish one adapter and re-run the
demo against a live testnet wallet. Defaults assumed for the build: Coinbase + Turnkey + Openfort on
Base Sepolia / Ethereum Sepolia / Polygon Amoy, testnet only.
