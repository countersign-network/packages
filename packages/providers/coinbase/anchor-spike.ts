/**
 * External ledger anchor — LIVE on Base Sepolia. Run from the repo root:
 *
 *   pnpm exec tsx packages/providers/coinbase/anchor-spike.ts
 *
 * Proves the "real external anchor" gap is closed: a signed ledger's HEAD is committed into a public
 * blockchain transaction (calldata), then read BACK FROM CHAIN and decoded — matching the live head
 * with no Countersign cooperation. The chain is a trust domain Countersign doesn't control, so a
 * silent history rewind is independently detectable. Uses the funded CDP wallet as the OnChainSender.
 * Testnet only.
 */

import { CdpClient } from "@coinbase/cdp-sdk";
import { createPublicClient, http } from "viem";
import { baseSepolia } from "viem/chains";
import dotenv from "dotenv";
import { asProviderId, type LedgerEvent } from "@countersign/core";
import { InMemoryLedger, OnChainAnchor, anchorHead, createEd25519Signer, decodeAnchorCalldata } from "@countersign/ledger";

dotenv.config();

async function main(): Promise<void> {
  for (const k of ["CDP_API_KEY_ID", "CDP_API_KEY_SECRET", "CDP_WALLET_SECRET"]) {
    if (!process.env[k]) throw new Error(`${k} is missing from .env`);
  }
  const cdp = new CdpClient();
  const publicClient = createPublicClient({ chain: baseSepolia, transport: http() });

  console.log("1/4 building a signed ledger with history…");
  const ledger = new InMemoryLedger<LedgerEvent>(createEd25519Signer());
  await ledger.append({ kind: "freeze_requested", freezeId: "frz_anchor", targets: [asProviderId("coinbase")], reason: "anchor spike", ts: Date.now() });
  await ledger.append({ kind: "freeze_resolved", freezeId: "frz_anchor", providerCount: 1, windowMs: 42, ts: Date.now() });
  const head = (await ledger.getHead())!;
  console.log(`    head: index=${head.index} rowHash=${head.rowHash.slice(0, 18)}…`);

  console.log("2/4 funding a CDP wallet (faucet)…");
  const account = await cdp.evm.createAccount();
  const { transactionHash: faucet } = await cdp.evm.requestFaucet({ address: account.address, network: "base-sepolia", token: "eth" });
  await publicClient.waitForTransactionReceipt({ hash: faucet });
  await new Promise((r) => setTimeout(r, 8000)); // balance sync

  console.log("3/4 anchoring the head ON-CHAIN (self-tx carrying the head as calldata)…");
  const anchor = new OnChainAnchor({
    explorerTxBase: "https://sepolia.basescan.org/tx/",
    async send(dataHex) {
      const { transactionHash } = await cdp.evm.sendTransaction({
        address: account.address,
        transaction: { to: account.address, value: 0n, data: dataHex },
        network: "base-sepolia",
      });
      return transactionHash;
    },
  });
  await anchorHead(ledger, anchor);
  const txHash = anchor.last()!.txHash as `0x${string}`;
  await publicClient.waitForTransactionReceipt({ hash: txHash });
  console.log(`    anchored: https://sepolia.basescan.org/tx/${txHash}`);

  console.log("4/4 INDEPENDENT verification — read the tx calldata back from chain + decode…");
  const tx = await publicClient.getTransaction({ hash: txHash });
  const decoded = decodeAnchorCalldata(tx.input);
  const ok = !!decoded && decoded.index === head.index && decoded.rowHash === head.rowHash.replace(/^0x/, "").toLowerCase();
  console.log(`    on-chain decodes to: index=${decoded?.index} rowHash=${decoded?.rowHash.slice(0, 18)}…`);

  console.log(`\n${ok ? "✅ SUCCESS" : "❌ MISMATCH"} — the ledger head is anchored on Base Sepolia and verifiable from chain alone.`);
  if (!ok) process.exit(1);
}

main().catch((err: unknown) => {
  const e = err as Record<string, unknown>;
  console.error("\n❌ anchor spike failed");
  console.error("  message:", e?.["message"]);
  if (e?.["cause"]) console.error("  cause:  ", (e["cause"] as Record<string, unknown>)?.["message"] ?? e["cause"]);
  process.exit(1);
});
