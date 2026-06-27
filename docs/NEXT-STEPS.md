# Countersign — Morning Next Steps (2026-06-21)

Read order: this file → `moat-and-integration-roadmap.md` (the moat/tier map) → `handoff.md` (the 90-day plan).

## Where we are

The build = **roadmap Tier 0** against faithful mocks, tested and committed to local `main` (not pushed):

| Roadmap Tier 0 item | State |
|---|---|
| #1 Coinbase / #2 Turnkey / #3 Openfort (+ #3b Lithic card) | **ALL LIVE on testnet** ✅ — each with `smoke.ts` + `spike.ts` proving real enforcement (in-policy allowed, over-cap/frozen declined) |
| #4 Countersign SDK / front door | **`@countersign/sdk` DONE + auth-capable** (typed client, Bearer + ws-ticket, live ledger subscribe) ✅ |
| Freeze + policy compiler + hash-chained ledger | **DONE & tested** (120 tests; signed + DB append-only + on-chain anchor) ✅ |
| Web dashboard (first-demo surface) | **DONE** — `pnpm --filter @countersign/api start` → http://localhost:8080 ✅ |

The falsifiable claim ("freeze N vendors at once in <1s, fully audited") is **proven FOR REAL** — a four-rail
live freeze (3 crypto wallets + a Visa card) in ~432ms via `packages/agent-harness/live-freeze.ts`, on top of
the credential-free mock suite. Next is enforcement-parity hardening and a third-party audit before mainnet.

### Security hardening completed (this session)
A 4-perspective hygiene/security audit + full remediation (P0→P2, then Low), all committed to local `main`:
- **P0:** fail-closed Coinbase freeze (confirm native, don't hard-code `true`); policy hex-address
  injection defense (compiler refuses non-hex); input validation + fail-closed boot guard.
- **P1:** no silent venue drop in the Turnkey compiler; honest auditable status when native enforcement
  isn't confirmed (Coinbase/Openfort emit a ledger `error` rather than implying a native guarantee).
- **P2:** error sanitization + 64KB body cap; **ws single-use tickets** (key no longer in the ws URL);
  trusted-proxy-aware + read-route rate limiting; SDK auth (Bearer + ticket); **Coinbase daily-cap TOCTOU**
  closed (reserve-before-send); **PgLedger appends serialized**; Turnkey session key held non-enumerable.
- **Low:** the live-proof scripts now typecheck; dead exports/deps trimmed.
- **License:** the front-door packages (`core`, `api-contract`, `sdk`, `mcp`) are now a real Apache-2.0
  grant (LICENSE shipped in-tarball + root carve-out); `api-contract`/`sdk` republished as **0.1.1**.

**Open security follow-ups (your call / need infra):**
- **npm provenance** — wire a GitHub Actions release workflow (`id-token: write`, `npm publish
  --provenance`) and store the npm automation token as a repo secret, so future publishes are provenanced.
  Currently publishing is manual from your machine, which can't attach provenance.
- The superseded **0.1.0** packages remain on npm (now `latest = 0.1.1`); no need to deprecate since we're
  honoring the Apache grant, but you may `npm deprecate ...@0.1.0 "use 0.1.1 (ships LICENSE)"` if you want.
- **Native-enforcement parity** (not yet confirmed end-to-end): Openfort on-chain KeysManager guard,
  Turnkey consensus gate, Lithic ASA — until then those rails are Countersign-layer-enforced (audited as such).
- **Third-party security audit** before any mainnet/real-custody use (still testnet-only, directive #6).

### Done in an earlier session
- Folded the moat/integration roadmap into `docs/moat-and-integration-roadmap.md`.
- Built **roadmap Tier 0 #4 in full** — `@countersign/sdk` (typed client) **and** `@countersign/mcp` (Countersign as
  MCP tools: the kill switch + spend guard inside any MCP client). Verified end-to-end over stdio.
- Shipped the **agent pre-flight spend guard** (`POST /evaluate`): an agent asks Countersign "may I spend?"
  before touching the wallet — the call made on every transaction (the flywheel).

## ① Decisions only you can make (≈15 min, do first — they unblock everything)

1. **Lock the §7 decisions** (handoff §7): confirm backends = Coinbase + Turnkey + Openfort, venues = Base Sepolia / Ethereum Sepolia / Polygon Amoy, **testnet only**. (Default already assumed in the build — just confirm or change.)
2. **Get Coinbase CDP sandbox creds** (API Key ID + Secret + Wallet Secret) → put in `.env`. This is the single unblock for the real test path. Turnkey + Openfort creds next.
3. **Name the first 5–10 design partners** (which communities). The ONE thing to validate with them: **do they run more than one wallet backend?** That assumption is the entire moat (roadmap moat #1/#2) — confirm or kill it before building aggregation depth.

## ② Then I build (ordered; roadmap tier in brackets)

A. **Real Coinbase adapter** [Tier 0 #1] → Phase-0 single-stop spike on Base Sepolia → **measure real freeze latency** (the number that validates the <1s claim under real network + on-chain lag). *Needs creds (item ①.2).*
~~B. Turnkey + Openfort adapters~~ **DONE** ✅ (2026-06-26) — BOTH LIVE.
- Turnkey: api.turnkey.com (pre-sign CEL, @turnkey/sdk-server v6.1.1); `spike.ts` proves in-policy
  allowed / over-cap denied / frozen denied with REAL in-enclave enforcement.
- Openfort: api.openfort.io (onchain-policy, @openfort/openfort-node v0.10.5); `spike.ts` proves
  sign-allowed → freeze (delete signer) → sign-denied.

## 🏁 THE HEADLINE IS PROVEN ON REAL VENDORS (2026-06-26)

`pnpm exec tsx packages/agent-harness/live-freeze.ts` — **three agents, three backends, three
venues, ONE freeze**: Coinbase (Base Sepolia) + Turnkey (Ethereum Sepolia) + Openfort (Polygon
Amoy), all confirmed in **~697ms (< 1s)**, signed hash-chained ledger verified. The falsifiable
claim is no longer "proven against mocks" — it's proven live.

Next (optional polish, no longer blocking): native hardening parity (Openfort on-chain KeysManager
guard, Turnkey consensus approval), webhook event streams, then the off-Free always-on deploy.

## Beyond crypto — the card rail (scaffolded 2026-06-26)

`packages/providers/lithic` is the first NON-crypto rail: a virtual Visa card under the same control
plane (native-session-caps — spend_limit = caps, PAUSE = freeze, CLOSE = kill; ASA auth-stream is the
inline-approval upgrade). Typed against `lithic` v0.123.0; `smoke.ts` + `spike.ts` (under-cap APPROVED,
over-cap DECLINED, frozen DECLINED via sandbox auth simulation) run once `LITHIC_API_KEY` (sandbox) is
set. With a key, the headline becomes "freeze an agent across Coinbase + Turnkey + Openfort **and a
Visa card**, one action" — the cross-RAIL-TYPE freeze, a sharper enterprise wedge than crypto-only.
Countersign stays the control plane (governs the customer's own Lithic program), never the issuer/custodian.
~~C. Countersign MCP server~~ **DONE** ✅ (`@countersign/mcp`) — and the spend guard (`/evaluate`).
~~D. x402 + USDC first-class~~ **DONE** ✅ (`@countersign/x402` — guard a machine-payment before it pays).
~~F. One-command / embedded MCP~~ **DONE** ✅ (`@countersign/mcp` runs an in-process Core, no creds, no setup).
~~E. Anomaly-freeze v0~~ **DONE** ✅ (`AnomalyMonitor` — velocity / blocked-burst / new-counterparty / cumulative → alert or auto-freeze; wired into the demo + live dashboard).
~~H. Approval workflow~~ **DONE** ✅ (`/approvals` `/approve` `/deny` — list + resolve `needs_approval`; fail-closed: a freeze overrides a pending approval; wired into the dashboard + MCP tools).
~~G. Hosted Core + durable Postgres~~ **DONE** ✅ — live at https://app.countersign.network (Render
Docker), now backed by a **signed Postgres ledger** (managed PG `dpg-d8uevjgk1i2s73esmeu0-a`, free plan
→ upgrade to basic-256mb for >30-day retention; `DATABASE_URL` wired). `/ledger` verifies + exposes the
public key. ⬜ Optional: publish `@countersign/mcp` to npm for a true one-line install; off-Free always-on.

~~A. Real Coinbase adapter + Phase-0 spike~~ **DONE** ✅ — LIVE on Base Sepolia (`spike.ts`).
~~Coinbase native hardening~~ **DONE** ✅ — per-tx cap pushed into Coinbase's MPC (CDP account
Policy); `harden-spike.ts` proves a direct over-cap send bypassing Countersign is rejected by Coinbase
itself. (API key needs the Non-custodial Manage / `policies#manage` scope.)
~~Deploy~~ **DONE** ✅ — live demo Core at https://app.countersign.network (Render Docker, Free plan).

> Remaining: (B) Turnkey + Openfort real adapters (need their sandbox creds); (G) hosted free tier
> (needs a deploy target); and the Coinbase hardening (native Spend Permissions, multi-backend <1s
> freeze once B lands). The single-backend live proof is DONE.

## ③ The one risk to kill this week

Operators must run **>1 backend** for the aggregation moat to matter. Put the dashboard + a tap-to-connect Coinbase flow in front of design partners and measure second-backend connect rate. Everything in Tiers 1–4 is downstream of this holding true.

## Monetisation (the short version — see chat for the full breakdown)

Land **usage-based** (governed agent-wallets + decisions evaluated, free testnet tier, SDK-led). Expand **enterprise**: the **sub-second cross-vendor freeze SLA**, the **hash-chained ledger as a compliance/audit product**, and **self-host** (the Go port). Price against avoided loss, not COGS. Tier 3 (cards/fiat) is the regulated mass-market expansion — after the proof, never before.

## Verify anytime

```
pnpm install && pnpm typecheck && pnpm test    # 120 tests
pnpm demo                                       # scripted headline
pnpm --filter @countersign/api start                 # dashboard at http://localhost:8080
```
