# Cosign

Neutral, cross-vendor control plane for AI agents that spend money.
We hold the policy, the freeze, and the audit ledger ACROSS multiple
agent-wallet backends at once — the one thing each vendor cannot do,
because they only govern their own rail.

## Prime directives (invariants — never violate)

1. Do NOT build cryptography. Integrate vendor MPC/TEE (Coinbase, Turnkey, Openfort).
   Agents use session keys, never master keys.
2. Build the layer ABOVE the wallets. The moat is cross-vendor aggregation, not the wallet.
3. Fail-closed. No decision / no backend response => transaction does NOT execute. Default deny.
4. Backend-agnostic: everything behind the `EnforcementProvider` interface
   (`packages/core/src/enforcement-provider.ts`). No vendor logic leaks into policy/ledger/api.
5. Append-only, hash-chained ledger is the source of truth.
6. Testnet only. No mainnet, no real custody, no PII/KYC.

## Before integrating any backend

Fetch and verify the CURRENT SDK/API for that vendor first — they ship fast.
Verified references live in `docs/sdk-research/`. Adapters in `packages/providers/*`
are skeletons until credentials exist (see §"Status" below).

## Stack

- **Core (the brain): TypeScript / Node.** Postgres (hash-chained ledger) · ws (freeze fan-out).
- **Client (thin, no keys): Flutter** — desktop + mobile, one codebase, generated from the OpenAPI spec.
- **Client↔Core contract = OpenAPI + typed ws schema**, single-sourced in `api-contract/`. Push via FCM/APNs (later).

## Repo layout

- `packages/core` — `EnforcementProvider` interface, branded ids, the fail-closed freeze controller.
- `packages/policy` — unified declarative policy (zod) + the compiler to each backend's native controls. **Core IP.**
- `packages/ledger` — append-only, hash-chained store (`LedgerPort` + in-memory + pglite adapters).
- `packages/providers/{mock,coinbase,turnkey,openfort}` — `EnforcementProvider` adapters.
- `packages/api` — Core service (REST + ws) the client talks to.
- `packages/agent-harness` — reference spending agents + the headline demo runner.
- `api-contract/` — OpenAPI + ws event schema (source of truth; generates the Dart client).
- `client/` — Flutter app (scaffold; Phase 3).

## Commands

```
pnpm install
pnpm typecheck     # strict TS across the workspace
pnpm test          # vitest: policy compiler, ledger hash-chain, fail-closed matrix, <1s freeze SLO
pnpm demo          # the headline: 3 agents / 3 modes / 3 venues, one freeze < 1s, ledger dump
```

## The one demo that defines done

Three agents, three backends, three venues. One action freezes all three in < 1s.
One ledger shows every attempt. If that runs on real-ish funds, the thesis is proven.

## Status (v1 / 90-day proof)

- DONE (credential-free): core interface + freeze controller, policy schema + compiler,
  hash-chained ledger, MockProvider (all 3 enforcement modes + fail-closed scenarios),
  REST+ws API, agent harness, the headline demo + full test suite — all run against **mocks**,
  no credentials required.
- SKELETONS (need vendor creds to finish): `packages/providers/{coinbase,turnkey,openfort}` —
  accurate signatures + real `capabilities()`, every other method throws `NotImplementedError`.
  To finish one: install its SDK, fill the methods per `docs/sdk-research/<vendor>.md`, add creds.
- DEFERRED: Flutter client beyond scaffold, FCM/APNs push, anomaly detection, real Postgres
  via testcontainers (pglite stands in for tests).
