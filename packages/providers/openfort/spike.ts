/**
 * Openfort Phase-0 proof (testnet-safe). Run from the repo root:
 *
 *   pnpm exec tsx packages/providers/openfort/spike.ts
 *
 * Part A — the adapter, live: provision a backend wallet (the agent's TEE-held signer), apply a
 *          unified policy, prove the wallet can SIGN, then freeze.
 * Part B — enforcement: after the freeze (which deletes the backend wallet), the same signing request
 *          FAILS — Openfort no longer holds a signer for the agent. A confirmed, custody-level kill.
 *
 * Per-tx caps for Openfort v1 are Cosign-layer (the on-chain KeysManager scope is the hardening step);
 * the freeze proof here is the kill switch — sign works before, is impossible after.
 */

import Openfort from "@openfort/openfort-node";
import dotenv from "dotenv";
import { asAgentId } from "@cosign/core";
import { definePolicy } from "@cosign/policy";
import { OpenfortProvider } from "./src/index";

dotenv.config();

const TREASURY = "0x000000000000000000000000000000000000dead";
const HASH = "0x" + "ab".repeat(32); // a 32-byte hash to sign

function req(key: string): string {
  const v = process.env[key];
  if (!v) throw new Error(`${key} is missing from .env`);
  return v;
}

async function signOnce(client: Openfort, accountId: string): Promise<{ outcome: "allowed" | "denied"; detail: string }> {
  try {
    const sig = await client.accounts.evm.backend.sign({ id: accountId, data: HASH });
    return sig ? { outcome: "allowed", detail: `signature produced (${String(sig).slice(0, 18)}…)` } : { outcome: "denied", detail: "no signature" };
  } catch (err) {
    return { outcome: "denied", detail: err instanceof Error ? err.message.split("\n")[0]! : String(err) };
  }
}

let pass = 0;
let fail = 0;
function check(label: string, got: string, want: string): void {
  const ok = got === want;
  ok ? pass++ : fail++;
  console.log(`   ${ok ? "✅" : "❌"} ${label}: ${got}${ok ? "" : ` (expected ${want})`}`);
}

async function main(): Promise<void> {
  const client = new Openfort(req("OPENFORT_SECRET_KEY"), { walletSecret: req("OPENFORT_WALLET_SECRET") });
  const provider = new OpenfortProvider();
  const agentId = asAgentId("openfort-spike-agent");

  console.log("Part A — provision + policy + sign + freeze (live api.openfort.io)\n");

  console.log("1/4 provisioning a backend wallet…");
  const ref = await provider.provisionWallet(agentId, { venue: "polygon-amoy" });
  const a = provider.getAgent(agentId)!;
  console.log("    account:", a.accountId, "->", ref.wallet);

  console.log("2/4 applying policy (per-tx cap 0.01 ETH + allowlist [treasury])…");
  const policy = definePolicy({ asset: "ETH", perTxCap: "10000000000000000", allowlist: [TREASURY], venues: ["polygon-amoy"] });
  const { policyId } = await provider.applyPolicy(agentId, policy);
  console.log("    applied:", policyId);

  console.log("3/4 enforcement BEFORE freeze (agent signs)…");
  const before = await signOnce(client, a.accountId);
  check("sign before freeze", before.outcome, "allowed");
  console.log("        ", before.detail);

  console.log("4/4 FREEZE…");
  const t0 = Date.now();
  const report = await provider.freeze({ kind: "provider-all" });
  const windowMs = Date.now() - t0;
  check("freeze confirmed", String(report.confirmed), "true");
  console.log(`         mechanism=${report.mechanism} frozenAgents=${report.frozenAgents.length} windowMs=${windowMs}`);

  console.log("\nPart B — enforcement AFTER freeze (same signing request)…");
  const after = await signOnce(client, a.accountId);
  check("sign after freeze blocked", after.outcome, "denied");
  console.log("        ", after.detail);

  console.log(`\n${fail === 0 ? "✅ SUCCESS" : "❌ FAILURES"} — ${pass} passed, ${fail} failed.`);
  if (fail > 0) process.exit(1);
}

main().catch((err: unknown) => {
  const e = err as Record<string, unknown>;
  console.error("\n❌ spike failed");
  console.error("  message:", e?.["message"]);
  if (e?.["cause"]) console.error("  cause:  ", (e["cause"] as Record<string, unknown>)?.["message"] ?? e["cause"]);
  process.exit(1);
});
