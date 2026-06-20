/**
 * Runnable Core service over a mock fleet (no credentials). For manual play:
 *   pnpm --filter @cosign/api start
 * then: curl localhost:8080/health · curl -XPOST localhost:8080/freeze · curl localhost:8080/ledger
 */

import { asAgentId } from "@cosign/core";
import { definePolicy } from "@cosign/policy";
import { MockProvider } from "@cosign/provider-mock";
import { CosignCore, createCosignServer } from "./index";

const core = new CosignCore();

const fleet = [
  { provider: new MockProvider({ id: "coinbase", mode: "native-session-caps" }), agent: "payments-bot", venue: "base-sepolia" },
  { provider: new MockProvider({ id: "turnkey", mode: "pre-sign-policy" }), agent: "trading-bot", venue: "ethereum-sepolia" },
  { provider: new MockProvider({ id: "openfort", mode: "onchain-policy" }), agent: "ops-bot", venue: "polygon-amoy" },
];

for (const f of fleet) {
  await core.registerProvider(f.provider);
  await core.provisionAgent(f.provider.id, asAgentId(f.agent), f.venue);
}

await core.applyPolicy(
  definePolicy({ asset: "USDC", perTxCap: "100000000", dailyCap: "1000000000", allowlist: ["0xTREASURY"] }),
);

const server = createCosignServer(core);
const port = await server.listen(Number(process.env["PORT"] ?? 8080));
console.log(`Cosign Core listening on http://localhost:${port}  (ws: ws://localhost:${port}/events)`);
