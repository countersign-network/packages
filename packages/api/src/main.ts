/**
 * Runnable Core service + the first-demo web dashboard, over a mock fleet (no credentials).
 *
 *   pnpm --filter @cosign/api start     # then open the printed URL
 *
 * A background loop drives the agents so the ledger streams live; hit FREEZE in the dashboard and
 * watch every backend stop and subsequent spends get blocked. Unfreeze to replay.
 */

import type { SpendAttempt } from "@cosign/policy";
import { createCosignServer, createDemoCore, type DemoFleetMember } from "./index";

const { core, fleet } = await createDemoCore();

const server = createCosignServer(core);
const port = await server.listen(Number(process.env["PORT"] ?? 8080));
console.log(`\n  Cosign dashboard:  http://localhost:${port}`);
console.log(`  REST + ws:         http://localhost:${port}  (ws /events)\n`);

// --- live agent activity so the dashboard has something to show ---
const pick = <T>(xs: T[]): T => xs[Math.floor(Math.random() * xs.length)]!;
const spendKinds: ((m: DemoFleetMember) => SpendAttempt)[] = [
  (m) => ({ amount: "50000000", asset: "USDC", counterparty: "0xTREASURY", venue: m.venue }), // allowed
  (m) => ({ amount: "150000000", asset: "USDC", counterparty: "0xTREASURY", venue: m.venue }), // blocked: per-tx cap
  (m) => ({ amount: "30000000", asset: "USDC", counterparty: "0xSTRANGER", venue: m.venue }), // blocked: allowlist
];

setInterval(() => {
  const m = pick(fleet);
  void m.provider.attemptSpend(m.agentId, pick(spendKinds)(m)).catch(() => {});
}, 1200);
