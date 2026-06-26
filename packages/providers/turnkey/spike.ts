/**
 * Turnkey Phase-0 proof (testnet-safe; Turnkey only signs, nothing is broadcast). Run from repo root:
 *
 *   pnpm exec tsx packages/providers/turnkey/spike.ts
 *
 * Part A — the adapter, live: provision an agent (sub-org + delegated user + EVM wallet), apply a
 *          unified policy (per-tx cap + allowlist) as Turnkey CEL, then freeze. Every step is a real
 *          api.turnkey.com activity.
 * Part B — real enforcement: the AGENT itself (with its own delegated P-256 key) asks Turnkey to sign
 *          three transactions. In-policy is ALLOWED; over-cap is DENIED in-enclave; and after the
 *          freeze even the in-policy one is DENIED. This is pre-sign policy enforcement that app code
 *          cannot bypass — the signature is simply never produced.
 *
 * NOTE: each run provisions fresh sub-orgs on your Turnkey org (testnet proof; they accumulate).
 */

import { Turnkey } from "@turnkey/sdk-server";
import { serializeTransaction, parseGwei, type Hex } from "viem";
import dotenv from "dotenv";
import { asAgentId } from "@cosign/core";
import { definePolicy } from "@cosign/policy";
import { TurnkeyProvider } from "./src/index";

dotenv.config();

const SEPOLIA = 11155111;
const TREASURY = "0x000000000000000000000000000000000000dead"; // allowlisted counterparty (lowercase)
const CAP_WEI = "10000000000000000"; // 0.01 ETH per-tx cap
const IN_POLICY_WEI = 5_000_000_000_000_000n; // 0.005 ETH (<= cap)
const OVER_CAP_WEI = 20_000_000_000_000_000n; // 0.02 ETH (> cap)

/** Build a raw unsigned EIP-1559 tx; Turnkey decodes eth.tx.{to,value,chain_id} from it. */
function unsignedTx(valueWei: bigint): string {
  const hex: Hex = serializeTransaction({
    type: "eip1559",
    chainId: SEPOLIA,
    nonce: 0,
    to: TREASURY as Hex,
    value: valueWei,
    gas: 21000n,
    maxFeePerGas: parseGwei("2"),
    maxPriorityFeePerGas: parseGwei("1"),
  });
  return hex.replace(/^0x/, ""); // Turnkey expects the unsigned tx hex without the 0x prefix
}

function req(key: string): string {
  const v = process.env[key];
  if (!v) throw new Error(`${key} is missing from .env`);
  return v;
}

/** Ask Turnkey (as the agent) to sign. Returns "allowed" | "denied". */
async function agentSign(
  subOrgId: string,
  agentKey: { publicKey: string; privateKey: string },
  walletAddress: string,
  valueWei: bigint,
): Promise<{ outcome: "allowed" | "denied"; detail: string }> {
  const agent = new Turnkey({
    defaultOrganizationId: subOrgId,
    apiBaseUrl: process.env["TURNKEY_API_BASE_URL"] ?? "https://api.turnkey.com",
    apiPrivateKey: agentKey.privateKey,
    apiPublicKey: agentKey.publicKey,
  });
  try {
    const res = await agent.apiClient().signTransaction({
      signWith: walletAddress,
      unsignedTransaction: unsignedTx(valueWei),
      type: "TRANSACTION_TYPE_ETHEREUM",
    });
    return res.signedTransaction
      ? { outcome: "allowed", detail: `signature produced (${res.signedTransaction.slice(0, 18)}…)` }
      : { outcome: "denied", detail: "no signature returned" };
  } catch (err) {
    return { outcome: "denied", detail: err instanceof Error ? err.message.split("\n")[0]! : String(err) };
  }
}

let pass = 0;
let fail = 0;
function check(label: string, got: string, want: string): void {
  const ok = got === want;
  if (ok) pass++;
  else fail++;
  console.log(`   ${ok ? "✅" : "❌"} ${label}: ${got}${ok ? "" : ` (expected ${want})`}`);
}

async function main(): Promise<void> {
  req("TURNKEY_ORGANIZATION_ID");
  req("TURNKEY_API_PUBLIC_KEY");
  req("TURNKEY_API_PRIVATE_KEY");

  const provider = new TurnkeyProvider();
  const agentId = asAgentId("turnkey-spike-agent");

  console.log("Part A — provision + policy + freeze (live api.turnkey.com)\n");

  console.log("1/4 provisioning agent (sub-org + delegated user + EVM wallet)…");
  const ref = await provider.provisionWallet(agentId, { venue: "ethereum-sepolia" });
  const a = provider.getAgent(agentId)!;
  console.log("    sub-org:", a.subOrgId);
  console.log("    wallet: ", ref.wallet);
  console.log("    agent user:", a.agentUserId);

  console.log("2/4 applying policy (per-tx cap 0.01 ETH + allowlist [treasury] on Sepolia)…");
  const policy = definePolicy({
    asset: "ETH",
    perTxCap: CAP_WEI,
    allowlist: [TREASURY],
    venues: ["ethereum-sepolia"],
  });
  const { policyId } = await provider.applyPolicy(agentId, policy);
  console.log("    applied:", policyId, "| turnkey policies:", a.turnkeyPolicyIds.length);

  // Policy activation is near-instant but eventually-consistent; let the engine pick it up before the
  // very first signature races ahead of it.
  await new Promise((r) => setTimeout(r, 3000));

  console.log("3/4 enforcement BEFORE freeze (agent signs)…");
  const inPolicy = await agentSign(a.subOrgId, a.agentKey, ref.wallet, IN_POLICY_WEI);
  check("in-policy (0.005 ETH -> treasury)", inPolicy.outcome, "allowed");
  console.log("        ", inPolicy.detail);
  const overCap = await agentSign(a.subOrgId, a.agentKey, ref.wallet, OVER_CAP_WEI);
  check("over-cap  (0.02 ETH -> treasury)", overCap.outcome, "denied");
  console.log("        ", overCap.detail);

  console.log("4/4 FREEZE…");
  const t0 = Date.now();
  const report = await provider.freeze({ kind: "provider-all" });
  const windowMs = Date.now() - t0;
  check("freeze confirmed", String(report.confirmed), "true");
  console.log(`         mechanism=${report.mechanism} frozenAgents=${report.frozenAgents.length} windowMs=${windowMs}`);

  console.log("\nPart B — enforcement AFTER freeze (agent signs the same in-policy tx)…");
  const afterFreeze = await agentSign(a.subOrgId, a.agentKey, ref.wallet, IN_POLICY_WEI);
  check("in-policy tx now blocked", afterFreeze.outcome, "denied");
  console.log("        ", afterFreeze.detail);

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
