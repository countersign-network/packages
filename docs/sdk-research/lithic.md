# Lithic — Card-Rail Adapter Integration Reference (verified 2026-06-26)

> The first NON-CRYPTO rail. Proves Cosign is rail-agnostic: the same policy + freeze + ledger governs
> a virtual Visa card. Verified against `lithic@0.123.0`. Re-verify before live calls.
> Cosign stays the CONTROL PLANE, never the issuer/custodian — it governs the customer's own Lithic
> program via their API key (no funds held; acts at the issuing API, not the PAN/PCI surface).

## 1. Install
```bash
npm install lithic   # v0.123.0
```

## 2. Auth / credentials + init
A single API key (`LITHIC_API_KEY`). The SDK picks `production` by default — **we force `sandbox`**
unless `LITHIC_ENV=production` (directive #6: testnet only). One key; sandbox vs production = the
`environment` option (different base URLs), not different keys.
```ts
import Lithic from "lithic"; // default export
const lithic = new Lithic({ apiKey: process.env.LITHIC_API_KEY, environment: "sandbox" });
```
Get a sandbox key from the Lithic dashboard (no funds, test BIN). It's the single value needed.

## 3. Provision: a virtual card per agent
```ts
const card = await lithic.cards.create({ type: "VIRTUAL", state: "OPEN", memo: "cosign-agent" });
// card.token (the handle), card.last_four, card.state, card.pan (sandbox returns the PAN)
```
`type`: MERCHANT_LOCKED | PHYSICAL | SINGLE_USE | VIRTUAL | UNLOCKED | DIGITAL_WALLET.

## 4. Policy — native spend control (enforced by Lithic/Visa)
```ts
await lithic.cards.update(token, { spend_limit: 5000, spend_limit_duration: "TRANSACTION" }); // cents
```
- `spend_limit` is in **CENTS** (minor units) — Cosign maps `UnifiedPolicy.perTxCap` to it.
- `spend_limit_duration` for the UPDATE API = `ANNUALLY | FOREVER | MONTHLY | TRANSACTION` — **note: no
  `DAILY`** (the type `SpendLimitDuration` excludes it, even though `CardCreateParams` lists DAILY).
  So `perTxCap` binds as TRANSACTION; `dailyCap` stays Cosign-enforced (don't approximate natively).
- Merchant / MCC allowlists = **Auth Rules** (`/v2/auth_rules`) + **ASA** (Authorization Stream
  Access, real-time approve/decline over a webhook) — the crypto-oriented UnifiedPolicy doesn't carry
  these yet; they're a UnifiedPolicy extension + the `supportsInlineApproval` upgrade.

## 5. Freeze / kill (card state)
`OPEN` approves · `PAUSED` declines (reversible) · `CLOSED` declines (irreversible). Confirm by reading
the returned card state back — never trust the call resolving alone (fail-closed).
```ts
await lithic.cards.update(token, { state: "PAUSED" });  // freeze (reversible)
await lithic.cards.update(token, { state: "OPEN" });    // unfreeze
await lithic.cards.update(token, { state: "CLOSED" });  // revokeSession (hard kill)
```

## 6. Proving enforcement (sandbox simulation)
```ts
const res = await lithic.transactions.simulateAuthorization({ amount: 3000, descriptor: "COSIGN TEST", pan });
const tx = await lithic.transactions.retrieve(res.token); // tx.result: 'APPROVED' | 'DECLINED' | 'CARD_SPEND_LIMIT_EXCEEDED' | 'CARD_PAUSED' | ...
```
`packages/providers/lithic/spike.ts` does exactly this: under-cap APPROVED, over-cap DECLINED, and
after freeze (paused) the in-policy auth DECLINED (CARD_PAUSED).

## 7. Health / events
- Health: `await lithic.cards.list()` (any authenticated call).
- Events: Lithic Events API + auth-stream webhooks (real-time authorization events) — phase-2
  (`realtimeEvents` / `subscribe`). ASA is the per-auth approve/decline gate (`supportsInlineApproval`).

## Adapter mapping (EnforcementMode = native-session-caps)
| Neutral verb | Lithic call |
|---|---|
| provisionWallet | cards.create({ type:"VIRTUAL", state:"OPEN" }) |
| applyPolicy | cards.update({ spend_limit, spend_limit_duration:"TRANSACTION" }) |
| freeze | cards.update({ state:"PAUSED" }) + confirm state (reversible) |
| unfreeze | cards.update({ state:"OPEN" }) |
| revokeSession (kill) | cards.update({ state:"CLOSED" }) |
| subscribe | Events API / auth-stream webhooks (phase-2) |
| health | cards.list() |

## Gotchas
- Default environment is PRODUCTION — always pass `environment: "sandbox"` for testnet (we fail-safe to it).
- `spend_limit` is cents (minor units), not the crypto base-unit string convention.
- Update's `SpendLimitDuration` has no DAILY; create's does. Don't assume parity.
- CLOSED is irreversible. PAUSED is the reversible freeze.
- PAN/PCI: sandbox returns the PAN on create/retrieve; in production, PAN access needs PCI-scoped
  retrieval — the adapter governs at the token/issuing level and never needs the PAN for policy/freeze.

Docs: `docs.lithic.com/docs/cards` · `/docs/managing-cards` · `/reference/patchcardbytoken`
· `/docs/authorization-rules-v2` · `/docs/simulating-transactions`.
