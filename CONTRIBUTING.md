# Contributing to Countersign

## Setup

```bash
pnpm install        # Node >= 22, pnpm 11 (see packageManager)
pnpm typecheck      # strict TS across the workspace
pnpm test           # vitest — must stay green
pnpm demo           # the scripted headline
pnpm --filter @countersign/api start   # Core + dashboard at http://localhost:8080
```

## The non-negotiables

Every change must respect the prime directives:

1. Don't build cryptography — integrate vendor MPC/TEE; session keys, never master keys.
2. Build the layer **above** the wallets; no vendor logic leaks past the `EnforcementProvider` interface.
3. **Fail-closed** — no decision / no backend response ⇒ the transaction does **not** execute.
4. The append-only, hash-chained ledger is the source of truth.
5. **Testnet only.**

## Conventions

- TypeScript, strict (`strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`). Keep
  `pnpm typecheck` and `pnpm test` green — CI runs both.
- Money is **always** a base-unit string, never a JS number (`@countersign/core` `money.ts`).
- New backends are adapters implementing `EnforcementProvider`; verify the vendor's current SDK
  first (`docs/sdk-research/`) and never weaken the fail-closed contract.
- Add tests with behaviour changes; the fail-closed paths especially must be covered.

## Working a vendor adapter

`packages/providers/{coinbase,turnkey,openfort,lithic}` are LIVE on testnet. To add a new rail or
deepen native enforcement on an existing one: install its SDK, implement against the
`EnforcementProvider` interface per `docs/sdk-research/<vendor>.md`, supply credentials via `.env`
(see `.env.example`), prove it with a `smoke.ts` (creds) + `spike.ts` (in-policy allowed / over-cap
declined), and keep `freeze()` fail-closed (return `{ confirmed: false }` if the stop can't be
confirmed — never report a freeze as safe when the backend didn't confirm it).
