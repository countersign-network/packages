# Cosign — Morning Next Steps (2026-06-21)

Read order: this file → `moat-and-integration-roadmap.md` (the moat/tier map) → `handoff.md` (the 90-day plan).

## Where we are

The build = **roadmap Tier 0** against faithful mocks, tested and committed to local `main` (not pushed):

| Roadmap Tier 0 item | State |
|---|---|
| #1 Coinbase / #2 Turnkey / #3 Openfort (enforcement backends) | adapter **skeletons** (real signatures + capabilities; live calls throw) — mock fleet proves the loop |
| #4 Cosign SDK / front door | **`@cosign/sdk` DONE** (typed client + live ledger subscribe) ✅ |
| Freeze + policy compiler + hash-chained ledger | **DONE & tested** (66 tests) ✅ |
| Web dashboard (first-demo surface) | **DONE** — `pnpm --filter @cosign/api start` → http://localhost:8080 ✅ |

The falsifiable claim ("freeze 3 vendors at once in <1s, fully audited") is **proven against mocks**. The only thing between here and proving it *for real* is vendor credentials.

### Done while you slept (this session)
- Folded the moat/integration roadmap into `docs/moat-and-integration-roadmap.md`.
- Built **roadmap Tier 0 #4 in full** — `@cosign/sdk` (typed client) **and** `@cosign/mcp` (Cosign as
  MCP tools: the kill switch + spend guard inside any MCP client). Verified end-to-end over stdio.
- Shipped the **agent pre-flight spend guard** (`POST /evaluate`): an agent asks Cosign "may I spend?"
  before touching the wallet — the call made on every transaction (the flywheel). 70 tests, green.

## ① Decisions only you can make (≈15 min, do first — they unblock everything)

1. **Lock the §7 decisions** (handoff §7): confirm backends = Coinbase + Turnkey + Openfort, venues = Base Sepolia / Ethereum Sepolia / Polygon Amoy, **testnet only**. (Default already assumed in the build — just confirm or change.)
2. **Get Coinbase CDP sandbox creds** (API Key ID + Secret + Wallet Secret) → put in `.env`. This is the single unblock for the real test path. Turnkey + Openfort creds next.
3. **Name the first 5–10 design partners** (which communities). The ONE thing to validate with them: **do they run more than one wallet backend?** That assumption is the entire moat (roadmap moat #1/#2) — confirm or kill it before building aggregation depth.

## ② Then I build (ordered; roadmap tier in brackets)

A. **Real Coinbase adapter** [Tier 0 #1] → Phase-0 single-stop spike on Base Sepolia → **measure real freeze latency** (the number that validates the <1s claim under real network + on-chain lag). *Needs creds (item ①.2).*
B. **Turnkey + Openfort adapters** [Tier 0 #2/#3] → the real cross-vendor <1s freeze (the headline / handoff Phase 2). *Needs creds.*
~~C. Cosign MCP server~~ **DONE** ✅ (`@cosign/mcp`) — and the spend guard (`/evaluate`).
~~D. x402 + USDC first-class~~ **DONE** ✅ (`@cosign/x402` — guard a machine-payment before it pays).
~~F. One-command / embedded MCP~~ **DONE** ✅ (`@cosign/mcp` runs an in-process Core, no creds, no setup).
~~E. Anomaly-freeze v0~~ **DONE** ✅ (`AnomalyMonitor` — velocity / blocked-burst / new-counterparty / cumulative → alert or auto-freeze; wired into the demo + live dashboard).
~~H. Approval workflow~~ **DONE** ✅ (`/approvals` `/approve` `/deny` — list + resolve `needs_approval`; fail-closed: a freeze overrides a pending approval; wired into the dashboard + MCP tools).
G. **Hosted free-tier deploy** of the Core (so `cosign-mcp` can default to a public testnet Core, not just embedded) + publish `@cosign/mcp` to npm for true one-line install. *(needs a deploy target from you)*

> Almost everything credential-free in Tier 0–1 is now built. The big unblocks left are YOURS:
> (A)/(B) wiring the **real vendor adapters** needs Coinbase/Turnkey/Openfort **sandbox credentials**;
> (G) the **hosted free tier** needs a **deploy target**. Then the proof runs on a live testnet wallet.

## ③ The one risk to kill this week

Operators must run **>1 backend** for the aggregation moat to matter. Put the dashboard + a tap-to-connect Coinbase flow in front of design partners and measure second-backend connect rate. Everything in Tiers 1–4 is downstream of this holding true.

## Monetisation (the short version — see chat for the full breakdown)

Land **usage-based** (governed agent-wallets + decisions evaluated, free testnet tier, SDK-led). Expand **enterprise**: the **sub-second cross-vendor freeze SLA**, the **hash-chained ledger as a compliance/audit product**, and **self-host** (the Go port). Price against avoided loss, not COGS. Tier 3 (cards/fiat) is the regulated mass-market expansion — after the proof, never before.

## Verify anytime

```
pnpm install && pnpm typecheck && pnpm test    # 66 tests
pnpm demo                                       # scripted headline
pnpm --filter @cosign/api start                 # dashboard at http://localhost:8080
```
