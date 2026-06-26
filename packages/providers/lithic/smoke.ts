/**
 * Lithic credential smoke test (SANDBOX). Proves LITHIC_API_KEY works end-to-end on the card
 * lifecycle Countersign relies on: create a virtual card -> pause it -> close it. Not part of the
 * build/typecheck. Run from the repo root so dotenv loads the root .env:
 *
 *   pnpm exec tsx packages/providers/lithic/smoke.ts
 */

import Lithic from "lithic";
import dotenv from "dotenv";

dotenv.config();

function req(key: string): string {
  const v = process.env[key];
  if (!v) throw new Error(`${key} is missing from .env`);
  return v;
}

async function main(): Promise<void> {
  const lithic = new Lithic({
    apiKey: req("LITHIC_API_KEY"),
    environment: process.env["LITHIC_ENV"] === "production" ? "production" : "sandbox",
  });

  console.log("1/3 creating a virtual card…");
  const card = await lithic.cards.create({ type: "VIRTUAL", state: "OPEN", memo: "countersign-smoke" });
  console.log("    card:", card.token, `****${card.last_four}`, "state", card.state);

  console.log("2/3 pausing (freeze)…");
  const paused = await lithic.cards.update(card.token, { state: "PAUSED" });
  console.log("    state:", paused.state);

  console.log("3/3 closing (kill)…");
  const closed = await lithic.cards.update(card.token, { state: "CLOSED" });
  if (closed.state !== "CLOSED") throw new Error(`expected CLOSED, got ${closed.state}`);

  console.log("\n✅ SUCCESS — your Lithic sandbox credentials work (card create -> pause -> close).");
}

main().catch((err: unknown) => {
  const e = err as Record<string, unknown>;
  console.error("\n❌ smoke test failed");
  console.error("  message:", e?.["message"]);
  console.error("  status: ", e?.["status"] ?? e?.["statusCode"]);
  if (e?.["error"]) console.error("  error:  ", e["error"]);
  process.exit(1);
});
