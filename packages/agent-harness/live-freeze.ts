/**
 * THE HEADLINE, on REAL vendors — three backends, three venues, ONE freeze. Run from the repo root:
 *
 *   pnpm exec tsx packages/agent-harness/live-freeze.ts
 *
 * Registers the three LIVE adapters into one CountersignCore:
 *   - Coinbase (Base Sepolia)      — native-session-caps (MPC)
 *   - Turnkey  (Ethereum Sepolia)  — pre-sign-policy (in-enclave CEL)
 *   - Openfort (Polygon Amoy)      — onchain-policy (backend wallet; freeze = revoke signer)
 * Provisions an agent on each, applies a SINGLE unified policy that the compiler lowers to each
 * backend's native controls, then fires one freezeAll() and measures the real cross-vendor freeze
 * window. Every step lands in the signed, hash-chained ledger. This is the falsifiable claim:
 * "three agents, three backends, three venues — one action stops all three in < 1s."
 *
 * Needs creds in .env: CDP_* (Coinbase), TURNKEY_* (Turnkey), OPENFORT_* (Openfort). Testnet only.
 */

import dotenv from "dotenv";
import { asAgentId } from "@countersign/core";
import { definePolicy } from "@countersign/policy";
import { CountersignCore } from "@countersign/api";
import { CoinbaseProvider } from "@countersign/provider-coinbase";
import { TurnkeyProvider } from "@countersign/provider-turnkey";
import { OpenfortProvider } from "@countersign/provider-openfort";

dotenv.config();

const TREASURY = "0x000000000000000000000000000000000000dead";
const CAP_WEI = "10000000000000000"; // 0.01 ETH per-tx cap

async function main(): Promise<void> {
  // Generous per-provider timeout so real network latency isn't mistaken for a hung backend; we want
  // to MEASURE the true window, not race a stopwatch. The fail-closed escalation still applies.
  const core = new CountersignCore({ freezeTimeoutMs: 5000, escalateTimeoutMs: 5000 });

  console.log("registering live providers (Coinbase + Turnkey + Openfort)…");
  await core.registerProvider(new CoinbaseProvider());
  await core.registerProvider(new TurnkeyProvider());
  await core.registerProvider(new OpenfortProvider());

  console.log("provisioning one agent on each backend…");
  const cb = await core.provisionAgent("coinbase", asAgentId("coinbase-agent"), "base-sepolia");
  console.log("   coinbase:", cb.wallet);
  const tk = await core.provisionAgent("turnkey", asAgentId("turnkey-agent"), "ethereum-sepolia");
  console.log("   turnkey: ", tk.wallet);
  const of = await core.provisionAgent("openfort", asAgentId("openfort-agent"), "polygon-amoy");
  console.log("   openfort:", of.wallet);

  console.log("applying ONE unified policy across all three (per-tx cap 0.01 ETH + allowlist)…");
  const policy = definePolicy({
    asset: "ETH",
    perTxCap: CAP_WEI,
    allowlist: [TREASURY],
    venues: ["base-sepolia", "ethereum-sepolia", "polygon-amoy"],
  });
  const applied = await core.applyPolicy(policy);
  console.log(`   applied to ${applied.applied.length} agent(s), ${applied.failed.length} failed`);

  // Let Turnkey's CEL policy propagate before the freeze (eventually-consistent activation).
  await new Promise((r) => setTimeout(r, 3000));

  console.log("\n🔴 FREEZE (one action, three vendors, concurrent fan-out)…\n");
  const report = await core.freezeAll("three-vendor live freeze");

  for (const p of report.providers) {
    const ok = p.stopped ? "✅" : "❌";
    console.log(`   ${ok} ${String(p.providerId).padEnd(9)} ${p.mode.padEnd(20)} ${p.outcome.padEnd(12)} ${p.latencyMs}ms`);
  }
  console.log(`\n   allStopped=${report.allStopped}  windowMs=${report.windowMs}  (freezeId ${report.freezeId})`);

  const verified = await core.verifyLedger();
  const records = await core.ledgerRecords();
  console.log(`   ledger: ${records.length} records, verified=${verified}, publicKey=${core.ledgerPublicKey() ? "present" : "none"}`);

  core.close();
  const sub1s = report.windowMs < 1000 ? " (< 1s ✅)" : "";
  const headline = report.allStopped
    ? `✅ THREE-VENDOR FREEZE CONFIRMED in ${report.windowMs}ms${sub1s} — Coinbase + Turnkey + Openfort, one action.`
    : `❌ NOT all stopped — see per-provider outcomes above (fail-closed: these are STILL DANGEROUS).`;
  console.log(`\n${headline}`);
  if (!report.allStopped) process.exit(1);
}

main().catch((err: unknown) => {
  const e = err as Record<string, unknown>;
  console.error("\n❌ live three-vendor freeze failed");
  console.error("  message:", e?.["message"]);
  if (e?.["cause"]) console.error("  cause:  ", (e["cause"] as Record<string, unknown>)?.["message"] ?? e["cause"]);
  process.exit(1);
});
