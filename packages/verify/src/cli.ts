#!/usr/bin/env node
/**
 * countersign-verify — verify a Countersign ledger inclusion proof offline.
 *
 *   # fetch a proof, then verify it with no Countersign-hosted dependency:
 *   curl -s -H "Authorization: Bearer $KEY" https://app.countersign.network/ledger/proof/41 > proof.json
 *   npx @countersign/verify proof.json
 *
 *   # or pipe it:
 *   curl -s ... | npx @countersign/verify
 *
 * Options:
 *   --public-key <base64>   verify signatures against this key instead of the bundle's own
 *   --root <hex>            additionally require the checkpoint's Merkle root to EQUAL this value
 *                           (e.g. a root you read yourself from the on-chain anchor)
 *
 * Exit code 0 = every applicable check passed; 1 = verification failed; 2 = usage/input error.
 */
import { readFileSync } from "node:fs";
import { verifyProofBundle, type ProofBundle } from "./index";

function fail(msg: string, code: number): never {
  console.error(msg);
  process.exit(code);
}

const args = process.argv.slice(2);
let file: string | undefined;
let publicKey: string | undefined;
let expectRoot: string | undefined;
for (let i = 0; i < args.length; i++) {
  const a = args[i]!;
  if (a === "--public-key") publicKey = args[++i];
  else if (a === "--root") expectRoot = args[++i]?.toLowerCase().replace(/^0x/, "");
  else if (a === "--help" || a === "-h") {
    console.log("usage: countersign-verify [proof.json] [--public-key <base64>] [--root <hex>]");
    process.exit(0);
  } else if (!a.startsWith("--")) file = a;
  else fail(`unknown option: ${a}`, 2);
}

let raw: string;
try {
  raw = file ? readFileSync(file, "utf8") : readFileSync(0, "utf8");
} catch (e) {
  fail(`could not read ${file ?? "stdin"}: ${e instanceof Error ? e.message : String(e)}`, 2);
}
let bundle: ProofBundle;
try {
  bundle = JSON.parse(raw) as ProofBundle;
} catch {
  fail("input is not valid JSON (expected a GET /ledger/proof/:index response)", 2);
}
if (!bundle?.record || !bundle?.proof || !bundle?.checkpoint) {
  fail("input does not look like a proof bundle (need record, proof, checkpoint)", 2);
}

const report = verifyProofBundle(bundle, publicKey ? { publicKey } : {});
const mark = (v: boolean | undefined): string => (v === undefined ? "–  (not applicable)" : v ? "✓" : "✗");
console.log(`row #${bundle.record.index} of ${bundle.checkpoint.size} (checkpoint ts ${bundle.checkpoint.ts})`);
console.log(`  chain hashes recompute   ${mark(report.checks.chainHash)}`);
console.log(`  Merkle inclusion         ${mark(report.checks.inclusion)}`);
console.log(`  row signature            ${mark(report.checks.rowSignature)}`);
console.log(`  checkpoint signature     ${mark(report.checks.checkpointSignature)}`);

let ok = report.ok;
if (expectRoot !== undefined) {
  const served = (bundle.checkpoint.merkleRoot ?? "").toLowerCase();
  const match = served === expectRoot;
  console.log(`  root matches --root      ${mark(match)}`);
  if (!match) {
    report.problems.push("served Merkle root does not equal the independently-obtained --root value");
    ok = false;
  }
}

for (const p of report.problems) console.error(`  ! ${p}`);
console.log(ok ? "VERIFIED — this entry is committed by the ledger." : "FAILED — do not trust this entry.");
process.exit(ok ? 0 : 1);
