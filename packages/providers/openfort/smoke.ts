/**
 * Openfort credential smoke test (testnet-safe). Proves OPENFORT_SECRET_KEY + OPENFORT_WALLET_SECRET
 * work end-to-end: create a backend wallet (uses both creds) then delete it (cleanup). Not part of
 * the build/typecheck. Run from the repo root so dotenv loads the root .env:
 *
 *   pnpm exec tsx packages/providers/openfort/smoke.ts
 */

import Openfort from "@openfort/openfort-node";
import dotenv from "dotenv";

dotenv.config();

function req(key: string): string {
  const v = process.env[key];
  if (!v) throw new Error(`${key} is missing from .env`);
  return v;
}

async function main(): Promise<void> {
  const openfort = new Openfort(req("OPENFORT_SECRET_KEY"), { walletSecret: req("OPENFORT_WALLET_SECRET") });

  console.log("1/2 creating a backend wallet (uses secret key + wallet secret)…");
  const acct = await openfort.accounts.evm.backend.create();
  console.log("    account:", acct.id, "->", acct.address);

  console.log("2/2 deleting it (cleanup)…");
  const del = await openfort.accounts.evm.backend.delete(acct.id);

  if (!del.deleted) throw new Error("wallet was not deleted");
  console.log("\n✅ SUCCESS — your Openfort credentials work (backend wallet create + delete).");
}

main().catch((err: unknown) => {
  const e = err as Record<string, unknown>;
  console.error("\n❌ smoke test failed");
  console.error("  message:    ", e?.["message"]);
  console.error("  name:       ", e?.["name"]);
  console.error("  statusCode: ", e?.["statusCode"] ?? e?.["status"]);
  console.error("  errorType:  ", e?.["errorType"]);
  if (e?.["cause"]) console.error("  cause:      ", (e["cause"] as Record<string, unknown>)?.["message"] ?? e["cause"]);
  process.exit(1);
});
