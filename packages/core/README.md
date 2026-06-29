# @countersign/core

The keystone types and primitives of [Countersign](https://countersign.network) — the neutral,
cross-vendor control plane for AI agents that spend money.

This package is **vendor- and storage-agnostic**: no wallet SDKs, no database, no network. It holds
the contract that every backend adapter implements and the fail-closed freeze controller that fans a
single kill switch out across them.

## What's in here

- **`EnforcementProvider`** — the interface every backend (Coinbase, Turnkey, Openfort, Lithic, …)
  implements: `provision`, `applyPolicy`, `freeze`, `evaluateAuthorization`, `capabilities`.
- **Branded ids + money primitives** — `AgentId`, `TenantId`, amounts in minor units, no float money.
- **`UnifiedPolicy`** — the declarative, zod-validated policy schema (per-tx caps, daily caps,
  allow/deny venues, approval thresholds, card real-time controls).
- **`CardRailProvider`** — an abstract base for real-time-auth card rails.
- **Ledger event vocabulary** — the typed events the append-only audit ledger records.
- **`FreezeController`** — the fail-closed, bounded-concurrency cross-venue freeze fan-out.

The policy **compiler** (the mapping from `UnifiedPolicy` to each backend's native controls) is the
proprietary brain and is **not** part of this open package.

## Install

```sh
npm i @countersign/core
```

Most integrators want [`@countersign/sdk`](https://www.npmjs.com/package/@countersign/sdk) (the typed
client over the Core API) rather than this package directly. Reach for `@countersign/core` when you
are implementing an `EnforcementProvider` or working against the policy/event types.

## License

Apache-2.0
