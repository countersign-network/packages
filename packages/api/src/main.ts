/**
 * Runnable Core service + the first-demo web dashboard, over a mock fleet (no credentials).
 *
 *   pnpm --filter @cosign/api start     # then open the printed URL
 *
 * A background loop drives the agents so the ledger streams live; hit FREEZE in the dashboard and
 * watch every backend stop and subsequent spends get blocked. Unfreeze to replay.
 */

import type { LedgerEvent } from "@cosign/core";
import { definePolicy, type SpendAttempt } from "@cosign/policy";
import { InMemoryLedger, PostgresLedger, createEd25519Signer } from "@cosign/ledger";
import { AnomalyMonitor, createCosignServer, createDemoCore, type ApiKeyInfo, type DemoFleetMember, type Role } from "./index";

// Sign the ledger so it's tamper-evident even against the DB owner. Set COSIGN_LEDGER_KEY (base64
// PKCS8) for a stable identity; otherwise a fresh key is generated each boot.
const signer = createEd25519Signer(process.env["COSIGN_LEDGER_KEY"]);
// Durable Postgres ledger when DATABASE_URL is set (Render managed PG); in-memory otherwise.
const databaseUrl = process.env["DATABASE_URL"];
const ledger = databaseUrl
  ? await PostgresLedger.create<LedgerEvent>(databaseUrl, signer)
  : new InMemoryLedger<LedgerEvent>(signer);

const { core, fleet } = await createDemoCore({ applyDefaultPolicy: false, ledger });
console.log(`  ledger: ${databaseUrl ? "Postgres" : "in-memory"} · signed (verify pubkey: ${signer.publicKey.slice(0, 24)}…)`);
// A policy with an approval band so the live dashboard surfaces pending approvals to act on.
await core.applyPolicy(
  definePolicy({
    asset: "USDC",
    perTxCap: "100000000", // 100 USDC
    dailyCap: "100000000000", // 100,000 USDC (generous for a long-running demo)
    allowlist: ["0xTREASURY"],
    approvalThreshold: "60000000", // > 60 USDC needs human approval
  }),
);

// Heuristic circuit breakers in ALERT mode — detections stream to the dashboard without halting the
// live demo. (Switch action to "freeze" to watch it auto-fire the kill switch.)
new AnomalyMonitor(core, {
  velocity: { maxSpends: 6, windowMs: 15_000, action: "alert" },
  blockedBurst: { maxBlocked: 4, windowMs: 15_000, action: "alert" },
});

// API auth: COSIGN_API_KEYS="key1:tenantA:operator,key2:tenantB:viewer" (role optional, defaults
// operator). Or COSIGN_API_KEY=<key> for tenant "default", operator. Unset => OPEN demo mode.
function parseApiKeys(): Record<string, ApiKeyInfo> {
  const map: Record<string, ApiKeyInfo> = {};
  const roleOf = (r?: string): Role => (r === "viewer" || r === "admin" ? r : "operator");
  for (const entry of (process.env["COSIGN_API_KEYS"] ?? "").split(",")) {
    const [key, tenant, role] = entry.split(":");
    if (key?.trim()) map[key.trim()] = { tenant: (tenant ?? "default").trim(), role: roleOf(role?.trim()) };
  }
  const single = process.env["COSIGN_API_KEY"]?.trim();
  if (single) map[single] = { tenant: "default", role: "operator" };
  return map;
}

const server = createCosignServer(core, { apiKeys: parseApiKeys() });
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

// Synthetic activity so the dashboard has something to show. Set COSIGN_DEMO_TRAFFIC=off for a
// real deploy that serves actual agents (otherwise the ledger fills with demo spends).
if (process.env["COSIGN_DEMO_TRAFFIC"] !== "off") {
  setInterval(() => {
    const m = pick(fleet);
    void m.provider.attemptSpend(m.agentId, pick(spendKinds)(m)).catch(() => {});
  }, 1200);

  // Occasionally request a spend in the approval band so the dashboard's approvals queue fills.
  setInterval(() => {
    const m = pick(fleet);
    void core.evaluateSpend(m.agentId, { amount: "75000000", asset: "USDC", counterparty: "0xTREASURY", venue: m.venue }).catch(() => {});
  }, 4000);
}
