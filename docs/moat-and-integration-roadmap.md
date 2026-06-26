# Countersign — Moat & Integration Roadmap

*Companion to the opportunity brief and the Claude Code handoff.*
*Principle: the integration list is the **substrate**, not the moat. Breadth of rails is table stakes; it's what makes the defensible layer possible. Don't confuse "most rails integrated" with "defensible."*

---

## Part A — The Moat (ranked by when it becomes real)

| # | Moat | Type | When it's real | Why a rail-specific player can't copy it |
|---|------|------|----------------|------------------------------------------|
| 1 | **Neutrality** | Positional | Day one | Every rail is issuer-side and governs only its own ecosystem; they compete, so none can build the cross-rail layer. Countersign holds the seat the giants are structurally barred from. (Plaid/Mint position — the keystone.) |
| 2 | **Cross-rail anomaly brain** | Data network effect | Compounds with usage | Countersign sees an agent's *entire* spend across all rails. A rail-specific player physically cannot see the pattern, so only Countersign can build real agent-spend anomaly detection. |
| 3 | **Switching cost** | Lock-in | As you become system-of-record | Once policy + ledger + agent-identity run an operator's fleet, leaving means re-architecting money flow. Deepest if you own an MPC share, not just wrap vendor MPC. |
| 4 | **Regulatory barrier** | Structural | Earned with custody | Co-signing/issuing puts you in AML/KYC/money-transmission territory. The wall that slows you keeps out the 191. |
| 5 | **Agent-spend identity + reputation** | Registry + network effect | Long game | Become the registry where an agent's mandate, audit trail, and reputation live across rails — the "agent passport." Shared bad-actor/known-drain signals improve with scale. Biggest end-state moat. |

**One line:** the rails are the substrate; the moat is the neutral layer plus the data only it can see.

---

## Part B — Integration Roadmap (priority order)

**Sequencing logic:** crypto-first (permissionless, agents spend *today*, zero regulatory drag) → protocol/settlement → identity/mandate (moat) → fiat/cards (mass-market but regulatory, defer) → enterprise custody (scale + owned-share path).

**Effort tags:** S ≈ days, M ≈ 1–2 weeks, L ≈ 3–6 weeks, XL ≈ multi-month / regulatory.

### Tier 0 — The 90-day proof (crypto enforcement backends + your own surface)

| # | Integration | Type | Effort | Capability Countersign extracts |
|---|-------------|------|--------|----------------------------|
| 1 | **Coinbase Agentic Wallets** | Enforcement backend | M | Per-agent MPC wallet, session caps, x402/Base settlement, MCP-Claude-native. Fastest backend; most agent-spend momentum. Freeze = revoke session. |
| 2 | **Turnkey** | Enforcement backend | M | TEE pre-sign policy engine; can gate a signature on approval. Different enforcement model → proves heterogeneity. You know it. |
| 3 | **Openfort** | Enforcement backend | M | Open-source, self-hostable, on-chain session-key policy. Freeze = flip on-chain guard → proves neutrality over an on-chain-enforced backend. |
| 4 | **Countersign MCP server / SDK** | Distribution surface | M | How agents/operators wire Countersign into the loop trivially. Your front door — build alongside #1. |

### Tier 1 — Settlement / protocol rails to observe + cap

| # | Integration | Type | Effort | Capability Countersign extracts |
|---|-------------|------|--------|----------------------------|
| 5 | **x402** | Settlement protocol | M | Govern the dominant machine-payment standard as a first-class rail across all providers; per-call metering + caps. |
| 6 | **Circle / USDC** | Settlement asset | S | The asset ~everything settles in; the money-movement substrate to monitor and rate-limit. |
| 7 | **Privy** | Enforcement backend | M | TEE + Shamir; extends coverage to user-session agent flows. You migrated to it. |

### Tier 2 — Identity / mandate / governance (the moat layer)

| # | Integration | Type | Effort | Capability Countersign extracts |
|---|-------------|------|--------|----------------------------|
| 8 | **Google AP2** | Mandate standard | L | Speak the emerging consent/mandate standard → become where mandates are issued, scoped, and audited. Feeds moat #5. |
| 9 | **Skyfire (KYA)** | Agent identity + reputation | M | Know-Your-Agent identity; feeds the reputation network effect (moat #2/#5). |
| 10 | **Nevermined** | A2A settlement + metering | M | Agent-to-agent commerce flows, programmable settlement, metering for agent-hires-agent. |

### Tier 3 — Fiat / cards (mass-market, regulatory — defer until post-proof)

| # | Integration | Type | Effort | Capability Countersign extracts |
|---|-------------|------|--------|----------------------------|
| 11 | **Stripe Agentic Commerce** | Fiat issuer | L | Virtual one-time cards + shared payment tokens; the biggest on-ramp to normal merchants. |
| 12 | **Visa Intelligent Commerce** | Card network | XL | Network-level agent authorization tokens; reach. |
| 13 | **Mastercard Agent Pay** | Card network | XL | Network-level agent payment credentials; reach. |
| 14 | **Crossmint** | Fiat issuer + compliance | L | Card rails + on/offramps + MiCA license — the compliant EU shortcut. |
| 15 | **Ramp / Brex agent cards** | SMB issuer | L | Expensable B2B agent spend — beachhead-2 (the SMB / agent-ops segment). |
| 16 | **AWS Bedrock AgentCore Payments** | Enforcement backend | L | Govern hyperscaler-issued agent spend cross-rail; reach into the AWS agent ecosystem. |

### Tier 4 — Enterprise custody + the owned-share path

| # | Integration | Type | Effort | Capability Countersign extracts |
|---|-------------|------|--------|----------------------------|
| 17 | **Fireblocks / Dfns / Sodot** | Custody / MPC infra | XL | The route to owning your own MPC share (vendor independence + deepest switching cost) and landing enterprise. Activates moats #3 and #4. |

---

## Part C — The strategic tell

- **Tiers 0–2 build your defensibility** (neutrality + data + identity), are crypto-native and permissionless, and have **zero regulatory drag**. This is where you win, and it's where the 90-day proof and the year-one product live.
- **Tier 3 is where mass-market revenue lives** — but it's a regulatory slog (issuing, AML/KYC, network approvals). Sequence it *after* the proof, never before. It's the expansion, not the wedge.
- **Tier 4 is the endgame** — owning custody flips you from aggregator to system-of-record and turns the regulatory wall into your moat.

**Build order in one breath:** prove the cross-rail freeze on three crypto backends (Tier 0), make x402/USDC first-class (Tier 1), become where mandates and agent identity live (Tier 2), *then* extend onto cards for the mass market (Tier 3), and finally own the custody layer (Tier 4).

> Reminder from the handoff: for every integration above, **do not rebuild the vendor's crypto** — wrap it behind the `EnforcementProvider` interface and extract only the capability named in the table. The moat is the aggregation, never the re-implementation.
