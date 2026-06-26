/**
 * Turnkey credential smoke test. Proves the three TURNKEY_* values in .env authenticate against
 * api.turnkey.com via getWhoami (the cheapest authenticated call). Not part of the build/typecheck.
 * Run from the repo root so dotenv loads the root .env:
 *
 *   pnpm exec tsx packages/providers/turnkey/smoke.ts
 */

import { Turnkey } from "@turnkey/sdk-server";
import dotenv from "dotenv";

dotenv.config();

function req(key: string): string {
  const v = process.env[key];
  if (!v) throw new Error(`${key} is missing from .env`);
  return v;
}

async function main(): Promise<void> {
  const turnkey = new Turnkey({
    defaultOrganizationId: req("TURNKEY_ORGANIZATION_ID"),
    apiBaseUrl: process.env["TURNKEY_API_BASE_URL"] ?? "https://api.turnkey.com",
    apiPrivateKey: req("TURNKEY_API_PRIVATE_KEY"),
    apiPublicKey: req("TURNKEY_API_PUBLIC_KEY"),
  });

  console.log("calling getWhoami…");
  const who = await turnkey.apiClient().getWhoami({});

  console.log("\n✅ SUCCESS — your Turnkey credentials authenticate against api.turnkey.com.");
  console.log("   organization:", who.organizationName, `(${who.organizationId})`);
  console.log("   user:        ", who.username, `(${who.userId})`);
}

main().catch((err: unknown) => {
  const e = err as Record<string, unknown>;
  console.error("\n❌ smoke test failed");
  console.error("  message:", e?.["message"]);
  console.error("  name:   ", e?.["name"]);
  if (e?.["cause"]) console.error("  cause:  ", (e["cause"] as Record<string, unknown>)?.["message"] ?? e["cause"]);
  process.exit(1);
});
