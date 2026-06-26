/**
 * Hardening proof (testnet) — the per-tx cap is enforced inside COINBASE'S MPC, not just by
 * Countersign's pre-check. We push the cap as a CDP account policy, then send DIRECTLY (bypassing
 * Countersign's gate, as a compromised agent would) and watch Coinbase reject the over-cap transaction.
 *
 *   pnpm exec tsx packages/providers/coinbase/harden-spike.ts
 */

import dotenv from "dotenv";
import { asAgentId } from "@countersign/core";
import { definePolicy } from "@countersign/policy";
import { CoinbaseProvider } from "./src/index";

dotenv.config();

const CAP = "500000000000"; //   0.0000005 ETH
const UNDER = "100000000000"; //  0.0000001 ETH (under cap)
const OVER = "1000000000000"; //  0.000001 ETH  (over cap, but affordable — so a rejection is the POLICY, not balance)

async function main(): Promise<void> {
  const provider = new CoinbaseProvider();
  const agent = asAgentId("hardening-bot");

  const ref = await provider.provisionWallet(agent, { venue: "base-sepolia" });
  console.log("wallet:", ref.wallet);
  await provider.fund(agent, { venue: "base-sepolia", token: "eth" });
  await new Promise((r) => setTimeout(r, 8000));

  console.log("\n→ applying policy and pushing the cap into Coinbase's MPC…");
  await provider.applyPolicy(agent, definePolicy({ asset: "ETH", perTxCap: CAP, allowlist: [ref.wallet] }));
  console.log("  native status:", provider.getNativeStatus(agent));

  console.log("\n[A] DIRECT send UNDER the cap (bypassing Countersign entirely)…");
  try {
    const tx = await provider.nativeSendUnchecked(agent, { to: ref.wallet, amountWei: UNDER, venue: "base-sepolia" });
    console.log("    → SENT ✓  https://sepolia.basescan.org/tx/" + tx);
  } catch (e) {
    console.log("    → unexpectedly rejected:", e instanceof Error ? e.message : String(e));
  }

  console.log("\n[B] DIRECT send OVER the cap (bypassing Countersign entirely)…");
  try {
    const tx = await provider.nativeSendUnchecked(agent, { to: ref.wallet, amountWei: OVER, venue: "base-sepolia" });
    console.log("    → ❌ NOT blocked (sent " + tx + ") — native cap NOT enforced");
  } catch (e) {
    console.log("    → ✅ REJECTED BY COINBASE — the cap is enforced in Coinbase's MPC, with Countersign not even in the loop.");
    console.log("       reason:", e instanceof Error ? e.message : String(e));
  }
}

main().catch((err: unknown) => {
  console.error("\n❌ harden-spike failed:", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
