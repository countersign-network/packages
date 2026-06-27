/**
 * Runnable Core service + the first-demo web dashboard, over a mock fleet (no credentials).
 *
 *   pnpm --filter @countersign/api start     # then open the printed URL
 *
 * A background loop drives the agents so the ledger streams live; hit FREEZE in the dashboard and
 * watch every backend stop and subsequent spends get blocked. Unfreeze to replay.
 */

import type { FreezeAlert, LedgerEvent } from "@countersign/core";
import { definePolicy, type SpendAttempt } from "@countersign/policy";
import { FileAnchor, InMemoryLedger, PostgresLedger, createEd25519Signer } from "@countersign/ledger";
import { AnomalyMonitor, CountersignCore, createCountersignServer, createDemoCore, type ApiKeyInfo, type DemoFleetMember, type Role } from "./index";

// Sign the ledger so it's tamper-evident even against the DB owner. Set COUNTERSIGN_LEDGER_KEY (base64
// PKCS8) for a stable identity; otherwise a fresh key is generated each boot.
const signer = createEd25519Signer(process.env["COUNTERSIGN_LEDGER_KEY"]);
// Durable Postgres ledger when DATABASE_URL is set (Render managed PG); in-memory otherwise.
const databaseUrl = process.env["DATABASE_URL"];
const ledger = databaseUrl
  ? await PostgresLedger.create<LedgerEvent>(databaseUrl, signer)
  : new InMemoryLedger<LedgerEvent>(signer);

// Optional external anchor for the ledger head (set COUNTERSIGN_ANCHOR_FILE). For a real cross-trust-domain
// guarantee, swap FileAnchor for an on-chain / transparency-log anchor (see ledger/anchor.ts).
const anchorFile = process.env["COUNTERSIGN_ANCHOR_FILE"];
const anchor = anchorFile ? new FileAnchor(anchorFile) : undefined;

// Two demo shapes:
//  - AMBIENT (COUNTERSIGN_DEMO_TRAFFIC=on, what the deployed core runs): pre-connected 3-backend fleet
//    with synthetic spend traffic, so the ledger streams live on its own.
//  - CONNECT (default, the moat-validation demo): an EMPTY core — the operator connects backends one
//    at a time in the dashboard, and the headline action is connecting a SECOND backend.
const ambient = process.env["COUNTERSIGN_DEMO_TRAFFIC"] === "on";

// Human escalation: POST a still-dangerous freeze to a pager/Slack webhook if one is configured.
// A kill switch nobody is alerted about isn't one (the ledger row alone won't page anyone).
const alertWebhook = process.env["COUNTERSIGN_ALERT_WEBHOOK"];
const alert = alertWebhook
  ? async (a: FreezeAlert): Promise<void> => {
      try {
        await fetch(alertWebhook, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            text: `⚠️ Countersign freeze STILL DANGEROUS (${a.freezeId}): ${a.dangerous.length} target(s) not confirmed stopped in ${a.windowMs}ms`,
            alert: a,
          }),
        });
      } catch (err) {
        console.error("[countersign] alert webhook POST failed:", err);
      }
    }
  : undefined;
if (alert) console.log("  alerting: still-dangerous freezes POST → COUNTERSIGN_ALERT_WEBHOOK");

let core: CountersignCore;
let fleet: DemoFleetMember[] = [];
if (ambient) {
  ({ core, fleet } = await createDemoCore({ applyDefaultPolicy: false, ledger, ...(anchor ? { anchor } : {}), ...(alert ? { alert } : {}) }));
  // A policy with an approval band so the live dashboard surfaces pending approvals to act on.
  await core.applyPolicy(
    definePolicy({
      asset: "USDC",
      perTxCap: "100000000", // 100 USDC
      dailyCap: "100000000000", // 100,000 USDC (generous for a long-running demo)
      allowlist: ["0x000000000000000000000000000000000000dEaD"],
      approvalThreshold: "60000000", // > 60 USDC needs human approval
    }),
  );
} else {
  core = new CountersignCore({ ledger, ...(anchor ? { anchor } : {}), ...(alert ? { alert } : {}) });
}
console.log(`  mode: ${ambient ? "ambient fleet demo" : "connect demo (start empty → connect backends)"}`);
console.log(`  ledger: ${databaseUrl ? "Postgres" : "in-memory"} · signed (verify pubkey: ${signer.publicKey.slice(0, 24)}…)${anchor ? ` · anchoring → ${anchorFile}` : ""}`);

// Heuristic circuit breakers in ALERT mode — detections stream to the dashboard without halting the
// live demo. (Switch action to "freeze" to watch it auto-fire the kill switch.)
new AnomalyMonitor(core, {
  velocity: { maxSpends: 6, windowMs: 15_000, action: "alert" },
  blockedBurst: { maxBlocked: 4, windowMs: 15_000, action: "alert" },
});

// API auth: COUNTERSIGN_API_KEYS="key1:tenantA:operator,key2:tenantB:viewer" (role optional, defaults
// operator). Or COUNTERSIGN_API_KEY=<key> for tenant "default", operator. Unset => OPEN demo mode.
function parseApiKeys(): Record<string, ApiKeyInfo> {
  const map: Record<string, ApiKeyInfo> = {};
  const roleOf = (r?: string): Role => (r === "viewer" || r === "admin" ? r : "operator");
  for (const entry of (process.env["COUNTERSIGN_API_KEYS"] ?? "").split(",")) {
    const [key, tenant, role] = entry.split(":");
    if (key?.trim()) map[key.trim()] = { tenant: (tenant ?? "default").trim(), role: roleOf(role?.trim()) };
  }
  const single = process.env["COUNTERSIGN_API_KEY"]?.trim();
  if (single) map[single] = { tenant: "default", role: "operator" };
  return map;
}

const apiKeys = parseApiKeys();

// FAIL-CLOSED BOOT: a Core wired to real vendor credentials must never run OPEN (no API auth) — a
// control plane that can move funds can't be left unauthenticated. The mock connect/ambient demo
// (no vendor creds) may stay open. Bypass only in dev/test.
const hasVendorCreds = ["CDP_API_KEY_ID", "TURNKEY_API_PRIVATE_KEY", "OPENFORT_SECRET_KEY", "LITHIC_API_KEY"].some(
  (k) => (process.env[k] ?? "").trim() !== "",
);
const env = process.env["NODE_ENV"];
if (hasVendorCreds && Object.keys(apiKeys).length === 0 && env !== "development" && env !== "test") {
  throw new Error(
    "refusing to boot: real vendor credentials are present but the API has no auth (set COUNTERSIGN_API_KEYS). A credential-backed Core must not run OPEN.",
  );
}

// Trust X-Forwarded-For only behind a known proxy that overwrites it (Render sets RENDER=true), or
// when TRUST_PROXY=1 is set explicitly — so the rate-limit key can't be spoofed in a direct deploy.
const trustProxy = process.env["TRUST_PROXY"] === "1" || process.env["RENDER"] === "true";
const server = createCountersignServer(core, { apiKeys, trustProxy });
const port = await server.listen(Number(process.env["PORT"] ?? 8080));
console.log(`\n  Countersign dashboard:  http://localhost:${port}`);
console.log(`  REST + ws:         http://localhost:${port}  (ws /events)\n`);

// --- live agent activity so the dashboard has something to show ---
const pick = <T>(xs: T[]): T => xs[Math.floor(Math.random() * xs.length)]!;
const spendKinds: ((m: DemoFleetMember) => SpendAttempt)[] = [
  (m) => ({ amount: "50000000", asset: "USDC", counterparty: "0x000000000000000000000000000000000000dEaD", venue: m.venue }), // allowed
  (m) => ({ amount: "150000000", asset: "USDC", counterparty: "0x000000000000000000000000000000000000dEaD", venue: m.venue }), // blocked: per-tx cap
  (m) => ({ amount: "30000000", asset: "USDC", counterparty: "0x0000000000000000000000000000000000005a7a", venue: m.venue }), // blocked: allowlist
];

// Synthetic activity (ambient demo only) so the deployed dashboard streams on its own. The connect
// demo stays quiet until the operator connects backends and drives the freeze themselves.
if (ambient) {
  setInterval(() => {
    const m = pick(fleet);
    void m.provider.attemptSpend(m.agentId, pick(spendKinds)(m)).catch(() => {});
  }, 1200);

  // Occasionally request a spend in the approval band so the dashboard's approvals queue fills.
  setInterval(() => {
    const m = pick(fleet);
    void core.evaluateSpend(m.agentId, { amount: "75000000", asset: "USDC", counterparty: "0x000000000000000000000000000000000000dEaD", venue: m.venue }).catch(() => {});
  }, 4000);
}
