/**
 * THE HEADLINE, on REAL rails — FOUR rails (3 crypto + a card), ONE freeze. Run from the repo root:
 *
 *   pnpm exec tsx packages/agent-harness/live-freeze.ts
 *
 * Registers the four LIVE adapters into one CountersignCore:
 *   - Coinbase (Base Sepolia)      — native-session-caps (MPC)
 *   - Turnkey  (Ethereum Sepolia)  — pre-sign-policy (in-enclave CEL)
 *   - Openfort (Polygon Amoy)      — onchain-policy (backend wallet; freeze = revoke signer)
 *   - Lithic   (Visa, sandbox)     — native-session-caps (card spend_limit; freeze = pause card)
 * Provisions an agent on each, applies a rail-denominated policy (crypto caps in wei, the card cap in
 * cents), then fires one freezeAll() and measures the real cross-rail freeze window. Every step lands
 * in the signed, hash-chained ledger. The falsifiable claim, widened beyond crypto: "four rails — one
 * action stops them all, crypto wallets AND a Visa card, in < 1s."
 *
 * Needs creds in .env: CDP_* (Coinbase), TURNKEY_* (Turnkey), OPENFORT_* (Openfort), LITHIC_API_KEY
 * (Lithic sandbox). Testnet only.
 */

import dotenv from "dotenv";
import { asAgentId } from "@countersign/core";
import { definePolicy } from "@countersign/policy";
import { CountersignCore } from "@countersign/api";
import { CoinbaseProvider } from "@countersign/provider-coinbase";
import { TurnkeyProvider } from "@countersign/provider-turnkey";
import { OpenfortProvider } from "@countersign/provider-openfort";
import { LithicProvider } from "@countersign/provider-lithic";

dotenv.config();

const TREASURY = "0x000000000000000000000000000000000000dead";
const CAP_WEI = "10000000000000000"; // 0.01 ETH per-tx cap (crypto rails, base units)
const CAP_CENTS = "5000"; // $50.00 per-tx cap (card rail, minor units)

async function main(): Promise<void> {
  // Generous per-provider timeout so real network latency isn't mistaken for a hung backend; we want
  // to MEASURE the true window, not race a stopwatch. The fail-closed escalation still applies.
  const core = new CountersignCore({ freezeTimeoutMs: 5000, escalateTimeoutMs: 5000 });

  console.log("registering live providers (Coinbase + Turnkey + Openfort + Lithic card)…");
  await core.registerProvider(new CoinbaseProvider());
  await core.registerProvider(new TurnkeyProvider());
  await core.registerProvider(new OpenfortProvider());
  await core.registerProvider(new LithicProvider());

  console.log("provisioning one agent on each backend (3 crypto rails + 1 card rail)…");
  const cb = await core.provisionAgent("coinbase", asAgentId("coinbase-agent"), "base-sepolia");
  console.log("   coinbase:", cb.wallet);
  const tk = await core.provisionAgent("turnkey", asAgentId("turnkey-agent"), "ethereum-sepolia");
  console.log("   turnkey: ", tk.wallet);
  const of = await core.provisionAgent("openfort", asAgentId("openfort-agent"), "polygon-amoy");
  console.log("   openfort:", of.wallet);
  const li = await core.provisionAgent("lithic", asAgentId("lithic-agent"), "visa");
  console.log("   lithic:  ", li.wallet);

  // One unified policy, but caps are rail-denominated: crypto in base units (wei), the card in minor
  // units (cents). Applied per agent so each rail gets a sensible cap. The freeze is rail-agnostic.
  console.log("applying the unified policy (crypto cap 0.01 ETH; card cap $50)…");
  const cryptoPolicy = definePolicy({ asset: "ETH", perTxCap: CAP_WEI, allowlist: [TREASURY], venues: ["base-sepolia", "ethereum-sepolia", "polygon-amoy"] });
  const cardPolicy = definePolicy({ asset: "USD", perTxCap: CAP_CENTS });
  let applied = 0, failed = 0;
  for (const id of ["coinbase-agent", "turnkey-agent", "openfort-agent"]) {
    const r = await core.applyPolicy(cryptoPolicy, asAgentId(id));
    applied += r.applied.length; failed += r.failed.length;
  }
  const rl = await core.applyPolicy(cardPolicy, asAgentId("lithic-agent"));
  applied += rl.applied.length; failed += rl.failed.length;
  console.log(`   applied to ${applied} agent(s), ${failed} failed`);

  // Let Turnkey's CEL policy propagate before the freeze (eventually-consistent activation).
  await new Promise((r) => setTimeout(r, 3000));

  console.log("\n🔴 FREEZE (one action, FOUR rails — 3 crypto + a Visa card — concurrent fan-out)…\n");
  const report = await core.freezeAll("four-rail live freeze");

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
    ? `✅ FOUR-RAIL FREEZE CONFIRMED in ${report.windowMs}ms${sub1s} — Coinbase + Turnkey + Openfort + a Visa card, one action.`
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
