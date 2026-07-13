# The guarded-payee pattern (A2A / AP2)

When agents hire agents, the agent **paying** carries the risk of the agent being **paid** — a
rogue payee mid-job is the payer's incident. This example shows the pattern that makes governance
propagate along the payment graph:

1. **The payee advertises it is governed** on its agent card: a `countersign` extension pointing at
   the Core that holds its policy, kill switch, and signed audit ledger. The ledger is the proof;
   the card is the pointer.
2. **The payer refuses ungoverned payees**, then **guards its own payment**: the AP2
   `PaymentMandate` is parsed to an exact base-unit amount and checked against the payer's policy
   *before the mandate is signed*. Denied means never signed.

Run it end-to-end against the hosted Core (self-serve sandbox, no account, testnet-only):

```sh
pnpm install
pnpm --filter @countersign/example-guarded-payee start
```

Expected output: the payee passes the governance check, a 0.40 USDC job is **allowed** (the mandate
gets signed), a 2 USDC job is **denied by policy before signing** (`Ap2Denied`), and both decisions
are already in the tamper-evident ledger.

Every piece is a published package: [`@countersign/ap2`](https://www.npmjs.com/package/@countersign/ap2)
(the mandate guard), [`@countersign/sdk`](https://www.npmjs.com/package/@countersign/sdk) (the typed
client). The same guard is one MCP tool call (`countersign_guard_ap2`) in Claude/Cursor via
[`@countersign/mcp`](https://www.npmjs.com/package/@countersign/mcp).

> The A2A agent-card extension schema is still settling upstream; treat the card shape here as
> illustrative. The pattern — advertise, verify, guard — is the part to copy.
