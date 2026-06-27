# @countersign/x402

**Govern [x402](https://x402.org) (HTTP-402 machine payments) with Countersign — guard an agent's payment against policy *before* it pays.**

When an agent hits a `402 Payment Required` challenge, route it through Countersign's pre-flight spend
guard first: parse the challenge → evaluate against one unified policy (per-call caps + payee allowlist
+ daily metering, fail-closed) → only hand off to the wallet/x402 client if allowed. Countersign
**decides; it never signs or moves funds.**

```ts
import { parseX402, withX402Guard } from "@countersign/x402";
import { CountersignClient } from "@countersign/sdk";

const cs = new CountersignClient({ baseUrl, apiKey });

// `challenge` is the 402 response body ({ accepts: [...] }).
const charge = parseX402(challenge);            // cheapest acceptable option, normalized
if (charge) {
  // Only pays if Countersign allows — a rogue or over-budget agent never pays.
  await withX402Guard(cs, agentId, charge, (c) => payWithYourX402Client(c));
}
```

- `parseX402(body)` — normalize a 402 challenge to a single charge (cheapest option, base units).
- `guardX402(api, agentId, charge)` — ask Countersign: allow / deny / needs_approval.
- `withX402Guard(api, agentId, charge, pay)` — evaluate, then run `pay` only on `allow`; throws `X402Denied` otherwise.

Apache-2.0. Pairs with `@countersign/sdk` and `@countersign/mcp`.
