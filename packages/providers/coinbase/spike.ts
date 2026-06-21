/**
 * Phase-0 spike (handoff §4) — the real proof on Base Sepolia:
 *   "a single transaction is provably prevented by a Cosign-issued policy change."
 *
 * Provision a real CDP wallet → fund it → apply a Cosign policy → spend within policy (a real
 * on-chain tx) → tighten/freeze → the next spend is BLOCKED (never sent). Run from the repo root:
 *   pnpm exec tsx packages/providers/coinbase/spike.ts
 */

import dotenv from "dotenv";
import { asAgentId, type LedgerEvent } from "@cosign/core";
import { definePolicy } from "@cosign/policy";
import { CosignCore } from "@cosign/api";
import { CoinbaseProvider } from "./src/index";

dotenv.config();

const ETH = (wei: string) => `${(Number(BigInt(wei)) / 1e18).toFixed(6)} ETH`;
const PER_TX_CAP = "100000000000000"; // 0.0001 ETH
const SMALL = "1000000000000"; //        0.000001 ETH (within cap)
const BIG = "5000000000000000"; //       0.005 ETH    (over cap)

async function main(): Promise<void> {
  const provider = new CoinbaseProvider();
  const core = new CosignCore();
  await core.registerProvider(provider);

  const agent = asAgentId("payments-bot");
  console.log("→ provisioning a real CDP wallet on Base Sepolia…");
  const ref = await core.provisionAgent("coinbase", agent, "base-sepolia");
  console.log("  wallet:", ref.wallet);

  console.log("→ funding from the testnet faucet…");
  await provider.fund(agent, { venue: "base-sepolia", token: "eth" });
  await new Promise((r) => setTimeout(r, 8000)); // balance sync

  console.log(`→ applying Cosign policy: per-tx cap ${ETH(PER_TX_CAP)}, allowlist [self]\n`);
  await core.applyPolicy(definePolicy({ asset: "ETH", perTxCap: PER_TX_CAP, allowlist: [ref.wallet] }), agent);

  const spend = (amount: string) => ({ amount, asset: "ETH", counterparty: ref.wallet, venue: "base-sepolia" });

  console.log(`[1] agent spends ${ETH(SMALL)} (within policy)…`);
  const r1 = await provider.attemptSpend(agent, spend(SMALL));
  console.log(`    → ${r1.outcome.toUpperCase()}` + (r1.outcome === "allowed" ? `  https://sepolia.basescan.org/tx/${r1.transactionHash}` : ""));

  console.log(`\n[2] agent spends ${ETH(BIG)} (over the per-tx cap)…`);
  const r2 = await provider.attemptSpend(agent, spend(BIG));
  console.log(`    → ${r2.outcome.toUpperCase()}` + (r2.outcome === "blocked" ? ` — ${r2.reason} (no transaction sent)` : ""));

  console.log(`\n[3] operator hits the KILL SWITCH (Cosign freeze)…`);
  const report = await core.freezeAll("operator hit the kill switch");
  console.log(`    → frozen in ${report.windowMs}ms`);

  console.log(`\n[4] agent tries the same in-policy ${ETH(SMALL)} spend again…`);
  const r3 = await provider.attemptSpend(agent, spend(SMALL));
  console.log(`    → ${r3.outcome.toUpperCase()}` + (r3.outcome === "blocked" ? ` — ${r3.reason} (PROVABLY PREVENTED — no transaction sent)` : ""));

  console.log("\n── unified ledger ──");
  for (const rec of await core.ledgerRecords()) {
    const e = rec.payload as LedgerEvent;
    console.log(`  #${String(rec.index).padStart(2, "0")} ${e.kind}`);
  }
  console.log(`\n  hash-chain verified: ${(await core.verifyLedger()) ? "✓ INTACT" : "✗"}`);
  console.log("\n✅ Phase-0 proven on a LIVE testnet wallet: a Cosign freeze prevented the transaction.");
}

main().catch((err: unknown) => {
  console.error("\n❌ spike failed:", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
