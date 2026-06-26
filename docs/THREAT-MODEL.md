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
3. **Backend ↔ chain/MPC/issuer.** Enforcement lives in vendor MPC/TEE, on-chain, OR a card
   issuer/network (Lithic/Visa spend controls). Countersign never holds keys, funds, or card PANs —
   on the card rail it governs the customer's own issuing program via their API key (control plane,
   not custodian/issuer), acting at the token/issuing layer, so it stays out of PCI-PAN scope.

## Adversaries & the invariant each faces

| Adversary | Defense (and where it lives) |
|---|---|
| **Compromised / rogue agent** | Native enforcement in the vendor (Coinbase MPC cap, Turnkey in-enclave CEL, Openfort on-chain guard, Lithic/Visa card spend_limit) — proven live across rails: an over-cap send is rejected by Coinbase, an over-cap signature denied in Turnkey's enclave, and an over-cap card auth declined by Lithic/Visa (`USER_TRANSACTION_LIMIT`); a frozen card declines (`CARD_PAUSED`). Plus Countersign's pre-flight guard + anomaly auto-freeze. |
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
- ✅ **External anchor (cross-trust-domain) — on-chain**: `OnChainAnchor` commits the ledger head
  (index + rowHash) into a public-chain transaction (calldata); the chain is a trust domain
  Countersign doesn't control, so a silent history rewind is detectable by anyone comparing the
  on-chain anchors to the live `/ledger`. The sender is injectable (vendor-agnostic) — proven live on
  Base Sepolia (`anchor-spike.ts`: head anchored, then read BACK FROM CHAIN and decoded to match).
  `FileAnchor` remains as a local audit trail (NOT cross-trust-domain on its own). Anchored after each
  freeze via the seam. ⬜ Transparency-log target (Rekor/OTS) is an alternative drop-in.
- ✅ **DB-level append-only** — a plpgsql trigger RAISES on any UPDATE/DELETE to the `ledger` table
  (pglite + real Postgres), so a direct-SQL attacker is blocked at the storage layer, not just by the
  port having no mutators. Tested. If the trigger is bypassed (superuser disable), the signed hash
  chain still detects the tamper (defense in depth).
- ✅ **Rate limiting** — fixed-window cap on mutating routes (per API key / per IP), 429 + Retry-After. Tested.
- ✅ **Supply chain** — `pnpm audit --prod --audit-level high` gates CI; Dependabot (npm + actions, weekly).
  Forced-patched transitive deps via `pnpm-workspace.yaml` overrides: `ws` (GHSA-96hv-2xvq-fx4p, via
  viem/isows) and `axios>=1.16.0` (GHSA-35jp-ww65-95wh et al., via `@openfort/openfort-node`). Prod tree clean.
- ✅ **invariant #5** — property test: every set policy field is natively enforced OR flagged
  `unsupported` (Countersign-enforced) — the compiler can't silently drop/weaken a field. All 3 modes.
- ✅ **Non-crypto (card) rail — control plane, not custodian** — the Lithic adapter governs the
  customer's own card-issuing program via their API key; Countersign never holds the PAN, funds, or
  issuer keys (acts at the token/issuing layer → out of PCI-PAN scope). Defaults to the SANDBOX
  environment (production is an explicit opt-in). Freeze is vendor-side (card PAUSE) and **confirmed by
  reading the card state back** — never trusts the API call merely resolving (fail-closed). Proven live.
- ✅ **Demo surface (`/connect`, `/backends`, `/metrics`)** — `/connect` is operator+ and rate-limited;
  reads are viewer+. The hosted connect demo is **mock-backed and the deployed Core holds no vendor
  creds**, so a visitor can never touch a real wallet/card; `/connect` is idempotent over a fixed
  3-backend catalog (no resource exhaustion).
- ⬜ **Third-party security audit** before mainnet / real funds. ⬜ Card rail: verify Lithic webhook
  signatures (ASA auth-stream) when that path is wired.
