/**
 * Lithic Phase-0 proof (SANDBOX) — a NON-CRYPTO rail under the same control plane. Run from repo root:
 *
 *   pnpm exec tsx packages/providers/lithic/spike.ts
 *
 * Via the adapter: provision a virtual card -> apply a per-tx cap -> simulate authorizations. An auth
 * UNDER the cap is APPROVED by Lithic/Visa; one OVER the cap is DECLINED (CARD_SPEND_LIMIT_EXCEEDED);
 * after FREEZE (card paused) even the in-policy auth is DECLINED (CARD_PAUSED). Same policy + freeze
 * thesis as the crypto adapters, on a card rail. Amounts are in CENTS.
 */

import Lithic from "lithic";
import dotenv from "dotenv";
import { asAgentId } from "@cosign/core";
import { definePolicy } from "@cosign/policy";
import { LithicProvider } from "./src/index";

dotenv.config();

const CAP_CENTS = 5000; // $50.00 per-tx cap
const UNDER = 3000; // $30.00
const OVER = 9000; // $90.00

function req(key: string): string {
  const v = process.env[key];
  if (!v) throw new Error(`${key} is missing from .env`);
  return v;
}

async function simulate(client: Lithic, pan: string, amount: number): Promise<{ outcome: "approved" | "declined"; detail: string }> {
  const res = await client.transactions.simulateAuthorization({ amount, descriptor: "COSIGN TEST", pan });
  if (!res.token) return { outcome: "declined", detail: "declined (no transaction created)" };
  const tx = await client.transactions.retrieve(res.token);
  return { outcome: tx.result === "APPROVED" ? "approved" : "declined", detail: tx.result };
}

let pass = 0;
let fail = 0;
function check(label: string, got: string, want: string): void {
  const ok = got === want;
  ok ? pass++ : fail++;
  console.log(`   ${ok ? "✅" : "❌"} ${label}: ${got}${ok ? "" : ` (expected ${want})`}`);
}

async function main(): Promise<void> {
  const client = new Lithic({
    apiKey: req("LITHIC_API_KEY"),
    environment: process.env["LITHIC_ENV"] === "production" ? "production" : "sandbox",
  });
  const provider = new LithicProvider();
  const agentId = asAgentId("lithic-spike-agent");

  console.log("1/4 provisioning a virtual card…");
  const ref = await provider.provisionWallet(agentId, { venue: "visa" });
  const a = provider.getAgent(agentId)!;
  const pan = (await client.cards.retrieve(a.cardToken)).pan;
  if (!pan) throw new Error("no PAN on the card (sandbox should return it)");
  console.log("    card:", ref.wallet);

  console.log(`2/4 applying policy (per-tx cap $${(CAP_CENTS / 100).toFixed(2)})…`);
  await provider.applyPolicy(agentId, definePolicy({ asset: "USD", perTxCap: String(CAP_CENTS) }));

  console.log("3/4 enforcement BEFORE freeze (simulate card auths)…");
  const under = await simulate(client, pan, UNDER);
  check("under-cap ($30) auth", under.outcome, "approved");
  console.log("        ", under.detail);
  const over = await simulate(client, pan, OVER);
  check("over-cap ($90) auth", over.outcome, "declined");
  console.log("        ", over.detail);

  console.log("4/4 FREEZE (pause the card)…");
  const t0 = Date.now();
  const report = await provider.freeze({ kind: "provider-all" });
  console.log(`         confirmed=${report.confirmed} mechanism=${report.mechanism} windowMs=${Date.now() - t0}`);

  console.log("\nenforcement AFTER freeze (same under-cap auth)…");
  const blocked = await simulate(client, pan, UNDER);
  check("under-cap auth now blocked", blocked.outcome, "declined");
  console.log("        ", blocked.detail);

  await provider.revokeSession(agentId); // CLOSE the card (cleanup + the hard kill)
  console.log(`\n${fail === 0 ? "✅ SUCCESS" : "❌ FAILURES"} — ${pass} passed, ${fail} failed.`);
  if (fail > 0) process.exit(1);
}

main().catch((err: unknown) => {
  const e = err as Record<string, unknown>;
  console.error("\n❌ spike failed");
  console.error("  message:", e?.["message"]);
  if (e?.["error"]) console.error("  error:  ", e["error"]);
  process.exit(1);
});
