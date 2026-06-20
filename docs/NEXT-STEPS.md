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
- Built **roadmap Tier 0 #4** — `@cosign/sdk` (the front door: `health/agents/applyPolicy/freeze/unfreeze/ledger` + live `subscribe()`), 4 tests, full suite green.

## ① Decisions only you can make (≈15 min, do first — they unblock everything)

1. **Lock the §7 decisions** (handoff §7): confirm backends = Coinbase + Turnkey + Openfort, venues = Base Sepolia / Ethereum Sepolia / Polygon Amoy, **testnet only**. (Default already assumed in the build — just confirm or change.)
2. **Get Coinbase CDP sandbox creds** (API Key ID + Secret + Wallet Secret) → put in `.env`. This is the single unblock for the real test path. Turnkey + Openfort creds next.
3. **Name the first 5–10 design partners** (which communities). The ONE thing to validate with them: **do they run more than one wallet backend?** That assumption is the entire moat (roadmap moat #1/#2) — confirm or kill it before building aggregation depth.

## ② Then I build (ordered; roadmap tier in brackets)

A. **Real Coinbase adapter** [Tier 0 #1] → Phase-0 single-stop spike on Base Sepolia → **measure real freeze latency** (the number that validates the <1s claim under real network + on-chain lag). *Needs creds (item ①.2).*
B. **Turnkey + Openfort adapters** [Tier 0 #2/#3] → the real cross-vendor <1s freeze (the headline / handoff Phase 2). *Needs creds.*
C. **Cosign MCP server** on top of `@cosign/sdk` [the agent-facing half of Tier 0 #4] → expose Cosign as MCP tools (check-policy / request-spend / freeze / ledger) so agents wire in natively. *No creds — I can start this anytime.*
D. **x402 + USDC first-class** [Tier 1 #5/#6] → govern the dominant machine-payment rail + the settlement asset.
E. **Anomaly-freeze v0 + design-partner onboarding** [handoff Phase 3 / roadmap moat #2].

> If you want progress before you've gathered creds, tell me to start **(C)** — it's the only fully-unblocked build item left in Tier 0.

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
