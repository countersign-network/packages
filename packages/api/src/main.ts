/**
 * Runnable Core service + the first-demo web dashboard, over a mock fleet (no credentials).
 *
 *   pnpm --filter @cosign/api start     # then open the printed URL
 *
 * A background loop drives the agents so the ledger streams live; hit FREEZE in the dashboard and
 * watch every backend stop and subsequent spends get blocked. Unfreeze to replay.
 */

import { asAgentId, type AgentId } from "@cosign/core";
import { definePolicy, type SpendAttempt } from "@cosign/policy";
import { MockProvider } from "@cosign/provider-mock";
import { CosignCore, createCosignServer } from "./index";

const core = new CosignCore();

interface Member {
  id: string;
  agentId: AgentId;
  venue: string;
  provider: MockProvider;
}

const SPECS = [
  { id: "coinbase", mode: "native-session-caps" as const, venue: "base-sepolia", label: "payments-bot" },
  { id: "turnkey", mode: "pre-sign-policy" as const, venue: "ethereum-sepolia", label: "trading-bot" },
  { id: "openfort", mode: "onchain-policy" as const, venue: "polygon-amoy", label: "ops-bot" },
];

const members: Member[] = [];
for (const s of SPECS) {
  const provider = new MockProvider({ id: s.id, mode: s.mode });
  await core.registerProvider(provider);
  const agentId = asAgentId(s.label);
  await core.provisionAgent(s.id, agentId, s.venue);
  members.push({ id: s.id, agentId, venue: s.venue, provider });
}

await core.applyPolicy(
  definePolicy({
    asset: "USDC",
    perTxCap: "100000000", // 100 USDC
    dailyCap: "100000000000", // 100,000 USDC — generous so the live loop runs for a long time
    allowlist: ["0xTREASURY"],
  }),
);

const server = createCosignServer(core);
const port = await server.listen(Number(process.env["PORT"] ?? 8080));
console.log(`\n  Cosign dashboard:  http://localhost:${port}`);
console.log(`  REST + ws:         http://localhost:${port}  (ws ${`/events`})\n`);

// --- live agent activity so the dashboard has something to show ---
const pick = <T>(xs: T[]): T => xs[Math.floor(Math.random() * xs.length)]!;
const spendKinds: ((venue: string) => SpendAttempt)[] = [
  (venue) => ({ amount: "50000000", asset: "USDC", counterparty: "0xTREASURY", venue }), // allowed
  (venue) => ({ amount: "150000000", asset: "USDC", counterparty: "0xTREASURY", venue }), // blocked: per-tx cap
  (venue) => ({ amount: "30000000", asset: "USDC", counterparty: "0xSTRANGER", venue }), // blocked: allowlist
];

setInterval(() => {
  const m = pick(members);
  void m.provider.attemptSpend(m.agentId, pick(spendKinds)(m.venue)).catch(() => {});
}, 1200);
