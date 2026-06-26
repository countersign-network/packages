# Countersign — Threat Model

Countersign governs money-moving AI agents, so security is the product, not a feature. This is a living
doc: every change is built against it. Pairs with `SECURITY.md` (disclosure) and `architecture.md`.

## Assets to protect

| Asset | Property that matters |
|---|---|
| **Policy** | Integrity — it must never be silently *weakened* (allow more than intended). |
| **The freeze** | Availability — the kill switch must always fire (fail-closed). |
| **The ledger** | Integrity — tamper-evident; the audit/compliance artifact. |
| **Credentials** | Confidentiality — vendor API keys, wallet secrets, the Core's own API keys. |
| **Agent authority** | Least-privilege — session keys, never master keys; bounded by policy. |

## Trust boundaries

1. **Client ↔ Core (the Dart/TS boundary).** Clients (Flutter, dashboard, MCP, SDK) hold **no keys**
   and can only call the API. A compromised client cannot move funds or weaken policy directly.
2. **Core ↔ Backends (`EnforcementProvider`).** No vendor SDK/keys leak past the interface.
3. **Backend ↔ chain/MPC.** Enforcement lives in vendor MPC/TEE or on-chain; Countersign never holds keys.

## Adversaries & the invariant each faces

| Adversary | Defense (and where it lives) |
|---|---|
| **Compromised / rogue agent** | Native enforcement in the vendor (Coinbase MPC cap, Openfort on-chain guard) — proven: a direct over-cap send bypassing Countersign is rejected by Coinbase. Plus Countersign's pre-flight guard + anomaly auto-freeze. |
| **Compromised client** | Holds no keys; API auth + RBAC; can only do what its key/tenant allows. |
| **Network MITM** | TLS everywhere (Render-provided). Webhook signatures verified per vendor. |
| **Compromised Core / host** | Fail-closed; least-privilege vendor scopes; secrets in env/secret-manager, never code. (Residual risk — see Gaps.) |
| **DB-write attacker** | Hash-chained ledger detects tampering. (Hardening: sign the head + external anchoring — see Gaps.) |
| **Insider / supply chain** | Lockfile + supply-chain policy + secret-scanning CI; minimal deps; audit log = the ledger. |

## Invariants (must always hold; tested)

1. **Fail-closed** — no decision / no backend response ⇒ deny. (Centralized; covered by the
   fail-closed test matrix.)
2. **Freeze always fires** — concurrent fan-out, per-provider timeout, escalation to `revokeSession`;
   anything unconfirmed is logged `still_dangerous`. (<1s SLO test.)
3. **Ledger is append-only + tamper-evident** — hash chain verified on read. (Tamper-detection tests
   on in-memory + Postgres.)
4. **Never reconstruct keys** — integrate vendor MPC/TEE only.
5. **Compiled policy is never weaker than the unified policy** — (test to add per backend).
6. **Testnet only** until a third-party audit.

## Status & gaps (the security roadmap)

- ✅ Fail-closed matrix · hash-chained ledger · native MPC enforcement (Coinbase) · anomaly
  auto-freeze · responsible disclosure (`SECURITY.md`) · least-privilege vendor scopes.
- ✅ **API auth + tenant seam** — JSON API requires an API key (`Authorization: Bearer`) when
  `COUNTERSIGN_API_KEYS` is set; resolves a tenant id. (Open in demo mode.)
- ✅ **Secret scanning** in CI (gitleaks) + `.gitleaks.toml`; `.env` gitignored.
- ✅ **Full multi-tenancy** — each tenant gets its own isolated `CountersignCore` (providers, policies,
  ledger), created lazily by `TenantRegistry` and selected per request from the API key's tenant.
  Tested: tenants see only their own agents, and a freeze in one tenant never touches another's
  ledger. (A single Core is still accepted for the single-tenant demo.)
- ✅ **RBAC** — keys carry a role (`viewer` / `operator` / `admin`); mutating + spend-decision routes
  require operator+, read routes viewer+ (403 otherwise). Tested.
- ✅ **Ledger signing** — each row is **Ed25519-signed** with a key the DB never holds
  (`COUNTERSIGN_LEDGER_KEY`, else ephemeral); verifying with the public key catches a *recomputed-chain*
  attack by a DB owner (tested). Public key is exposed at `GET /ledger` for independent verification.
  **Anchoring seam in place**: `LedgerAnchor` (+ `FileAnchor` reference) publishes the head after
  each freeze; swap in an on-chain / transparency-log anchor for a real cross-trust-domain guarantee.
  ⬜ Still to do: a real external anchor target + DB-level append-only (block UPDATE/DELETE).
- ✅ **Rate limiting** — fixed-window cap on mutating routes (per API key / per IP), 429 + Retry-After. Tested.
- ✅ **Supply chain** — `pnpm audit --prod --audit-level high` gates CI; Dependabot (npm + actions, weekly).
  Forced a patched `ws` via a `pnpm-workspace.yaml` override (GHSA-96hv-2xvq-fx4p). Prod tree is clean.
- ✅ **invariant #5** — property test: every set policy field is natively enforced OR flagged
  `unsupported` (Countersign-enforced) — the compiler can't silently drop/weaken a field. All 3 modes.
- ⬜ **Third-party security audit** before mainnet / real funds.
