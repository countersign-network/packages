/**
 * Credential smoke test (testnet only). Proves the three CDP_* values in .env work end-to-end:
 * create a wallet → fund from the Base Sepolia faucet → send a transaction. Not part of the build
 * or typecheck; run from the repo root so dotenv loads the root .env:
 *
 *   pnpm exec tsx packages/providers/coinbase/smoke.ts
 */

import { CdpClient } from "@coinbase/cdp-sdk";
import { createPublicClient, http, parseEther } from "viem";
import { baseSepolia } from "viem/chains";
import dotenv from "dotenv";

dotenv.config();

async function main(): Promise<void> {
  for (const k of ["CDP_API_KEY_ID", "CDP_API_KEY_SECRET", "CDP_WALLET_SECRET"]) {
    if (!process.env[k]) throw new Error(`${k} is missing from .env`);
  }

  const cdp = new CdpClient();
  const publicClient = createPublicClient({ chain: baseSepolia, transport: http() });

  console.log("1/4 creating wallet…");
  const account = await cdp.evm.createAccount();
  console.log("    wallet:", account.address);

  console.log("2/4 requesting testnet ETH from the faucet…");
  const { transactionHash: faucetHash } = await cdp.evm.requestFaucet({
    address: account.address,
    network: "base-sepolia",
    token: "eth",
  });
  await publicClient.waitForTransactionReceipt({ hash: faucetHash });
  console.log("    funded:", faucetHash);

  console.log("3/4 waiting for balance to sync…");
  await new Promise((r) => setTimeout(r, 8000));

  console.log("4/4 sending a transaction…");
  const { transactionHash } = await cdp.evm.sendTransaction({
    address: account.address,
    transaction: { to: account.address, value: parseEther("0.000001") },
    network: "base-sepolia",
  });
  await publicClient.waitForTransactionReceipt({ hash: transactionHash });

  console.log("\n✅ SUCCESS — your CDP credentials work on Base Sepolia.");
  console.log("   BaseScan: https://sepolia.basescan.org/tx/" + transactionHash);
}

main().catch((err: unknown) => {
  const e = err as Record<string, unknown>;
  console.error("\n❌ smoke test failed");
  console.error("  message:    ", e?.["message"]);
  console.error("  name:       ", e?.["name"]);
  console.error("  statusCode: ", e?.["statusCode"] ?? e?.["status"]);
  console.error("  errorType:  ", e?.["errorType"]);
  console.error("  errorMsg:   ", e?.["errorMessage"]);
  console.error("  correlationId:", e?.["correlationId"]);
  if (e?.["cause"]) console.error("  cause:      ", (e["cause"] as Record<string, unknown>)?.["message"] ?? e["cause"]);
  process.exit(1);
});
