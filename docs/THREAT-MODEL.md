# Cosign — Threat Model

Cosign governs money-moving AI agents, so security is the product, not a feature. This is a living
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
3. **Backend ↔ chain/MPC.** Enforcement lives in vendor MPC/TEE or on-chain; Cosign never holds keys.

## Adversaries & the invariant each faces

| Adversary | Defense (and where it lives) |
|---|---|
| **Compromised / rogue agent** | Native enforcement in the vendor (Coinbase MPC cap, Openfort on-chain guard) — proven: a direct over-cap send bypassing Cosign is rejected by Coinbase. Plus Cosign's pre-flight guard + anomaly auto-freeze. |
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
  `COSIGN_API_KEYS` is set; resolves a tenant id. (Open in demo mode.)
- ✅ **Secret scanning** in CI (gitleaks) + `.gitleaks.toml`; `.env` gitignored.
- ⬜ **Full multi-tenancy** — today one Core; next: a Core (or row-level `tenant_id`) per tenant,
  selected by the API key. The auth→tenant resolution is the seam.
- ✅ **RBAC** — keys carry a role (`viewer` / `operator` / `admin`); mutating + spend-decision routes
  require operator+, read routes viewer+ (403 otherwise). Tested.
- ✅ **Ledger signing** — each row is **Ed25519-signed** with a key the DB never holds
  (`COSIGN_LEDGER_KEY`, else ephemeral); verifying with the public key catches a *recomputed-chain*
  attack by a DB owner (tested). Public key is exposed at `GET /ledger` for independent verification.
  ⬜ Still to do: **external anchoring** of the head hash (transparency log / on-chain) + DB-level
  append-only (block UPDATE/DELETE).
- ⬜ **Rate limiting** on mutating endpoints; **invariant #5** test; **`pnpm audit` + Dependabot** in CI.
- ⬜ **Third-party security audit** before mainnet / real funds.
