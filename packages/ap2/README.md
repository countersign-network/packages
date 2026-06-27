# @countersign/ap2

**Govern [AP2](https://ap2-protocol.org) (the Agent Payments Protocol) with Countersign — guard an agent's mandate against policy *before* it signs the PaymentMandate.**

When an agent is about to commit to a merchant-signed Cart/Checkout Mandate — the moment a final amount
and payee are known but funds have *not* moved — route it through Countersign's pre-flight spend guard:
parse the mandate → evaluate against one unified policy (per-call caps + payee allowlist + daily metering,
fail-closed) → only sign/send the PaymentMandate if allowed. Countersign **decides; it never signs a
mandate or moves funds.**

```ts
import { parseAp2, withAp2Guard } from "@countersign/ap2";
import { CountersignClient } from "@countersign/sdk";

const cs = new CountersignClient({ baseUrl, apiKey });

// `mandate` is a merchant-signed AP2 Cart/Checkout Mandate (or a PaymentMandate).
const charge = parseAp2(mandate);                 // normalized: amount (minor units) + currency + payee
if (charge) {
  // Only signs/sends if Countersign allows — a rogue or over-budget agent never pays.
  await withAp2Guard(cs, agentId, charge, (c) => signAndSendPaymentMandate(c));
}
```

- `parseAp2(mandate)` — normalize an AP2 mandate to a single charge. Handles **both** spec generations:
  Gen-1 (W3C-PaymentRequest, float *major* units) and Gen-2/v0.2 (SD-JWT VC, int *minor* units); the
  amount is always returned as an integer minor-unit string.
- `guardAp2(api, agentId, charge)` — ask Countersign: allow / deny / needs_approval.
- `withAp2Guard(api, agentId, charge, pay)` — evaluate, then run `pay` only on `allow`; throws `Ap2Denied` otherwise.

AP2 has no official npm/TS SDK yet and the spec (v0.2) is still evolving — the mandate types here are
transcribed from the reference schemas. Pairs with `@countersign/sdk`, `@countersign/mcp`, and `@countersign/x402`.

Apache-2.0.
