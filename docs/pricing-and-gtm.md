# Countersign — Pricing & GTM (one-pager)

*Companion to the opportunity brief, the handoff, and the moat/integration roadmap.*

## Positioning

The neutral **kill switch + audit trail** for AI agents that spend money — policy, freeze, and a
tamper-evident ledger **across every wallet vendor at once**. The one thing no single rail can sell
you, because each only governs its own ecosystem.

## Growth — product-led, three loops

You integrate vendors **directly and permissionlessly** (Tier 0–1 are self-serve; no partnership
needed). Partnerships are *pulled in by demand*, never a prerequisite.

1. **Distribution loop (now):** the **MCP server** drops Countersign *inside Claude/Cursor/Code* where
   agent builders already are — one command, embedded mode, no creds. Open-source the front door
   (interface + SDK + MCP + contract) → discoverable, forkable, the de-facto neutral standard.
2. **Data/flywheel loop (compounds):** the **spend guard** (`/evaluate`) is called on every
   transaction → Countersign sees an agent's *entire* cross-rail spend → better anomaly signals + agent
   reputation → safer → more adoption → more data. A single-rail vendor physically can't build this.
3. **Trust + A2A loops:** the hash-chained ledger is shareable compliance proof (pulls in the org);
   and when agents hire agents, the payer wants the payee governed → governance propagates along the
   spend graph.

**Leading metrics:** decisions evaluated/week (flywheel fuel) · % of operators connecting a *second*
backend (the moat assumption — validate first) · time-to-first-freeze.

## Monetisation — free to adopt, metered in production, enterprise for the guarantees

Price against **avoided loss** (a rogue agent can drain a treasury; Countersign is cheap insurance), not
COGS. The `/evaluate` guard + the ledger are an exact, tamper-evident usage meter — **the meter is
the audit log**.

| Tier | Price (illustrative) | For | Boundary |
|---|---|---|---|
| **Free / Dev** | $0 | Adoption + flywheel fuel | Testnet, open-source front door, embedded Core, generous decision quota, N agents, short retention |
| **Team / Pro** | base + usage ($/1k decisions **or** $/governed-agent/mo, + per-x402-call) | The land tier | Mainnet, anomaly brain, 90-day ledger, dashboard seats |
| **Enterprise** | annual, ~$50k–$250k+ | The money | **Sub-second cross-vendor freeze SLA**, signed compliance/audit export + retention (SOC2), SSO/RBAC, **self-host license**, dedicated support |
| **Endgame: insured freeze / custody** | premium + a few bps on governed mainnet volume | When you own an MPC share | Contractually/insurance-backed freeze; system-of-record (roadmap moat #3/#4) |

Anchors: Stripe Radar (~$0.05–0.07/txn screened) for per-decision economics; Fireblocks-class
($tens-of-thousands+/yr) for enterprise/custody.

### Free is an investment, not lost revenue

The moat compounds with volume, so **maximise** free/cheap usage early and monetise *outcomes*
(freeze SLA, compliance, mainnet, enterprise controls, self-host) — never *adoption*. Never gate the
SDK/MCP/interface or testnet.

### Sequencing (don't monetise before demand)

Tier 0–1 now = adoption (free/dev + light testnet usage). **Revenue turns on at mainnet + enterprise**
(SLA, compliance, self-host). Cards/fiat (roadmap Tier 3) is later expansion, never the wedge. Avoid
leading with a bps take-rate — save it for the insured-freeze endgame.

## What needs the founder

Lock the §7 decisions (backends/venues/funds), gather sandbox creds, name the first design partners,
and decide the open-core license split when ready (front door → permissive; brain → proprietary).
