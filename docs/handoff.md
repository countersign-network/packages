# Countersign — Claude Code Handoff (v1 / 90-Day Proof)

*Goal of v1: one demo — freeze three live spending agents running on three different wallet backends across three venues, in under a second, with a unified tamper-evident ledger of every attempt.*

---

## 0. Read this first — the prime directives

These are non-negotiable. Tell Claude Code to treat them as invariants.

1. **Do NOT build cryptography.** MPC/TEE signing is a solved, commodity primitive (Coinbase Agentic Wallets, Turnkey, Openfort). Integrate it. Never reconstruct keys. Agents use **session keys, never master keys**.
2. **The product is the layer ABOVE the wallets, not the wallet.** Countersign is the neutral, cross-vendor policy + freeze + ledger surface. Every wallet vendor only governs its own ecosystem; Countersign governs all of them at once. That aggregation is the entire moat — build that, not a redundant wallet.
3. **Fail-closed, always.** No policy decision, or no response from an enforcement backend → the transaction does **not** execute. Default deny.
4. **Backend-agnostic core.** All wallet vendors sit behind one `EnforcementProvider` interface. No vendor-specific logic leaks into the core. Swapping or adding a backend must not touch policy, ledger, or UI.
5. **Everything is logged** to an append-only, hash-chained ledger. The ledger is the source of truth and the audit artifact.
6. **Testnet only for the proof.** No mainnet, no real custody at scale, no PII/KYC. (Optional small real-funds run only in the design-partner phase, with consent.)

**Step zero for Claude Code:** these vendors ship fast (Coinbase Agentic Wallets is Feb 2026). Before writing integration code, fetch and verify each backend's *current* SDK/API surface and auth flow. Don't code against assumed endpoints.

---

## 1. What we're building (v1 scope)

A thin neutral control plane with four parts:

- **EnforcementProvider abstraction** — common interface over heterogeneous agent-wallet backends (provision wallet, apply policy, request action, freeze/revoke, stream events).
- **Unified policy model + compiler** — one declarative policy (JSON) that compiles down to each backend's native controls (Turnkey policy language, Coinbase session caps, Openfort on-chain session keys). *This compiler is core IP.*
- **Cross-venue freeze controller** — one action that, across every connected backend and agent, sets policy to deny, revokes/rotates session keys, and (where on-chain) flips the account guard. Sub-second propagation.
- **Unified ledger** — append-only, hash-chained Postgres log indexing backend webhooks + on-chain events: every attempted, allowed, and blocked action, with which policy + who/what approved.

Plus the surfaces to demo it:
- **Countersign Client (Flutter — desktop + mobile, one codebase)** — policy editor, live multi-venue agent monitor, one big red FREEZE button, ledger view, approval prompts. **Holds no keys and no wallet SDKs**; it is a thin renderer over the Core API. Mobile is load-bearing, not optional: the approval prompt and the on-the-go kill switch only make sense on a phone.
- **Agent harness** — reference spending agents, one per backend, to make the demo real.

**Architecture in one line:** a TypeScript **Core service** (the brain — adapters, policy compiler, freeze controller, ledger, REST+ws API) that the **Flutter client** talks to. All crypto/SDK weight lives in Core, written once; the client just renders state and fires `approve` / `freeze`. The language boundary (Dart client / TS core) falls exactly on the trust boundary — a compromised client still cannot move funds or weaken policy.

---

## 2. Recommended stack (verified against the 2026 landscape)

**Enforcement backends — integrate, don't build (pick these three for heterogeneity):**
| Backend | Why it's in the proof | Notes |
|---|---|---|
| **Coinbase Agentic Wallets** | MPC + session caps + native **x402** + **MCP server compatible with Claude**; `npx awal`; Base-native, gasless | Fastest path; on-thesis (x402/USDC on Base) |
| **Turnkey** | TEE-isolated keys, **policy engine evaluated before signing**, sub-100ms, 30+ chains; delegated agent signing | You have prior Turnkey experience; strongest key model |
| **Openfort** | **Open-source, self-hostable** (OpenSigner, MIT), ERC-4337/EIP-7702 smart accounts, **on-chain** session-key policy | Proves the neutral layer works over an on-chain-enforced backend too |

(Privy — TEE + Shamir, off-chain policy — is a viable swap given your migration history, but it leans toward user-session flows rather than fully autonomous agents. Crossmint is the later fiat/MiCA route, out of scope now.)

**Countersign core + harness:** **TypeScript / Node** for the proof — every wallet SDK (Coinbase CDP, Turnkey, Openfort) is TS-first, so this minimizes integration friction. (Port the durable policy/ledger service to **Go** later if you want; not for the proof.)

**Ledger:** Postgres, append-only, **hash-chained** (each row stores `prev_hash` + payload hash). Index backend webhooks and on-chain events.

**Real-time freeze:** Redis pub/sub + websockets; freeze fans out to every provider concurrently.

**Client:** **Flutter** — macOS, Windows, Linux, iOS, Android from one codebase. Chosen over Tauri 2 because Flutter's desktop *and* mobile are battle-tested today, while Tauri 2's mobile is still maturing and the 1→2 churn is real risk for a reliability-critical product. The client holds no keys and no wallet SDKs. (A plain web dashboard is fine for the very first demo; build the Flutter client from Phase 3, but the decision is locked now so there's no rewrite.)

**The Client↔Core contract is the real interface — single-source it.** Define the API once: **OpenAPI** for REST + a typed JSON schema for the websocket event stream. Generate the Dart client from the spec so the `approve` / `freeze` / `ledger` contract never drifts between Dart and TS. Treat the spec as the source of truth, not the code.

**Push notifications are load-bearing.** The approval prompt and the on-the-go kill switch live on the phone. Wire **FCM/APNs** early in the mobile work — a freeze alert that arrives 30 seconds late is a failed product. Do not defer it to the end of Phase 3.

**Standards substrate to be aware of (don't reimplement):** ERC-4337, EIP-7702, ERC-7579 modular accounts (Biconomy Nexus, ZeroDev Kernel V3), ERC-7715 scoped permissions (draft, but shipped in MetaMask/Coinbase/Rhinestone/Biconomy stacks). Openfort handles these under the hood.

---

## 3. Repo layout (monorepo, pnpm workspaces)

```
countersign/
├── CLAUDE.md                 # context + prime directives (see §6)
├── docs/
│   ├── opportunity-brief.md  # the strategy doc
│   └── handoff.md            # this file
├── packages/
│   ├── core/                 # EnforcementProvider interface, freeze controller, types
│   ├── policy/               # unified policy schema + per-backend compiler
│   ├── ledger/               # hash-chained append-only store + indexer
│   ├── providers/
│   │   ├── coinbase/         # Coinbase Agentic Wallet adapter
│   │   ├── turnkey/          # Turnkey adapter
│   │   └── openfort/         # Openfort adapter
│   ├── api/                  # Core service (REST/ws) the client talks to
│   └── agent-harness/        # reference spending agents, one per backend
├── api-contract/             # OpenAPI spec + ws event schema (source of truth); generates Dart client
├── client/                   # Flutter app (macOS, Windows, Linux, iOS, Android)
└── contracts/                # only if a custom guard/module is needed (Foundry)
```

---

## 4. Build order — phases with Definition of Done

### Phase 0 — Scaffold + the single-stop spike (Week 1)
- Scaffold monorepo, `CLAUDE.md`, CI, env config. Get sandbox creds for all three backends.
- Confirm the three testnets/venues (default: Base Sepolia + two others).
- **Spike:** provision one Coinbase Agentic Wallet, run one agent that spends, then **block its next transaction via policy**. Prove the stop works end to end.
- **DoD:** a single transaction is provably prevented by a Countersign-issued policy change.

### Phase 1 — One backend, full loop (Days 0–30)
- `EnforcementProvider` interface + Coinbase adapter.
- Unified policy schema v0 + compiler for the Coinbase backend (per-tx cap, daily cap, allow/deny list, approval threshold, freeze flag).
- Hash-chained ledger + indexer; one reference agent; CLI `freeze`.
- **DoD:** agent spends within policy; a `freeze` blocks the next spend; ledger shows the attempt + the block + the governing policy.

### Phase 2 — Make it cross-venue (Days 30–60)
- Add Turnkey and Openfort adapters behind the same interface; compiler targets all three.
- Cross-venue freeze controller with concurrent fan-out; unified ledger across all three.
- **DoD (the headline):** three agents on three backends across three venues; **one freeze action stops all three in < 1 second**; one ledger shows every attempt everywhere.

### Phase 3 — Flutter client + anomaly v0 + design partners (Days 60–90)
- Lock the **OpenAPI + ws event spec** first; generate the Dart client from it.
- Flutter client (desktop + mobile): policy editor, live multi-venue monitor, big red FREEZE, ledger view, approval prompts.
- **Push notifications (FCM/APNs)** for approval requests and freeze alerts — wired early, not last.
- Anomaly-freeze v0: heuristic circuit breakers (spend velocity, threshold breach, new counterparty) → auto-freeze.
- Onboard 5–10 design-partner operators (testnet, or small real funds with consent).
- **DoD:** the headline demo runs from the Flutter client (including a freeze fired from a phone) on real-ish multi-venue agents; design partners are live and giving feedback.

---

## 5. Out of scope for v1 (say no to these now)
Card/fiat issuing · mainnet / real custody at scale · AML/KYC · owning your own MPC share (stay an aggregation layer on vendor MPC for now) · ML-based anomaly detection (heuristics only) · consumer UX polish · production multi-tenant / billing.

---

## 6. CLAUDE.md starter (drop in repo root)

```markdown
# Countersign

Neutral, cross-vendor control plane for AI agents that spend money.
We hold the policy, the freeze, and the audit ledger ACROSS multiple
agent-wallet backends at once — the one thing each vendor cannot do,
because they only govern their own rail.

## Prime directives (invariants — never violate)
1. Do NOT build cryptography. Integrate vendor MPC/TEE (Coinbase, Turnkey, Openfort).
   Agents use session keys, never master keys.
2. Build the layer ABOVE the wallets. The moat is cross-vendor aggregation, not the wallet.
3. Fail-closed. No decision / no backend response => transaction does NOT execute. Default deny.
4. Backend-agnostic: everything behind the EnforcementProvider interface.
5. Append-only, hash-chained ledger is the source of truth.
6. Testnet only. No mainnet, no real custody, no PII/KYC.

## Before integrating any backend
Fetch and verify the CURRENT SDK/API for that vendor first — they ship fast.

## Stack
Core (the brain): TypeScript/Node · Postgres (hash-chained ledger) · Redis+ws (freeze fan-out).
Client (thin, no keys): Flutter — desktop + mobile, one codebase, generated from the OpenAPI spec.
Client↔Core contract = OpenAPI + typed ws schema, single-sourced. Push via FCM/APNs.

## The one demo that defines done
Three agents, three backends, three venues. One action freezes all three in < 1s.
One ledger shows every attempt. If that runs on real-ish funds, the thesis is proven.
```

---

## 7. Decisions for YOU (not Claude Code) — lock these before Phase 1

1. **Confirm the three backends** (recommended: Coinbase Agentic + Turnkey + Openfort) and the **three venues/chains**.
2. **TypeScript-first for the proof** — confirm (vs your Go preference for the durable service later).
3. **Long-term posture:** stay an aggregation layer on vendor MPC, or eventually **own an MPC share** for vendor-independence + the custody/regulatory moat. (Product phase — but it shapes the architecture, so decide the *intent* now.)
4. **Design-partner sourcing:** which crypto / agent-builder / DePIN communities you'll recruit the 5–10 operators from.
5. **Real funds vs testnet** for the Phase 3 design-partner run.

---

## 8. Immediate next steps (this week)
1. Lock the five decisions in §7.
2. Create the repo with the `CLAUDE.md` and `docs/` above.
3. Point Claude Code at **Phase 0** with one instruction: *"Verify the current Coinbase Agentic Wallet SDK, then build the single-stop spike per docs/handoff.md §4."*
4. Once the spike blocks a transaction, you have proof-of-mechanism — greenlight Phase 1.
5. In parallel (you, not Claude Code): start a public "agent safety / the kill switch agents need" point of view to build the audience that becomes your GTM wedge.

---

**The whole thing reduces to one falsifiable test:** can Countersign freeze agents across three vendors at once in under a second? Phase 2 answers it. Everything before is setup; everything after is scale.
