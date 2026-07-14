import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { verifyProofBundle, verifyInclusion, payloadHash, computeRowHash, type ProofBundle } from "../src/index";

/**
 * P1.7 — the CROSS-IMPLEMENTATION fixture: `valid-proof.json` was produced by the real Core
 * (a live GET /ledger/proof bundle over a signed ledger, including a denied over-cap spend), and is
 * verified here by this package's INDEPENDENT math. If the Core's hashing/Merkle/signature rules
 * ever drift from this public specification, this test breaks.
 */
const load = (): ProofBundle =>
  JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "fixtures", "valid-proof.json"), "utf8")) as ProofBundle;

describe("@countersign/verify — offline proof verification", () => {
  it("verifies a genuine Core-produced bundle end to end (chain hashes, inclusion, both signatures)", () => {
    const r = verifyProofBundle(load());
    expect(r.problems).toEqual([]);
    expect(r.checks).toEqual({ chainHash: true, inclusion: true, rowSignature: true, checkpointSignature: true });
    expect(r.ok).toBe(true);
  });

  it("a TAMPERED payload fails (the negative fixture): the amount is edited after the fact", () => {
    const b = load();
    (b.record.payload as { action: { amount: string } }).action.amount = "1"; // rewrite history: 9000000 → 1
    const r = verifyProofBundle(b);
    expect(r.ok).toBe(false);
    expect(r.checks.chainHash).toBe(false);
    expect(r.problems.some((p) => p.includes("payload"))).toBe(true);
  });

  it("a substituted rowHash fails inclusion; a forged row signature fails the key check", () => {
    const substituted = load();
    substituted.record.rowHash = "ab".repeat(32);
    expect(verifyProofBundle(substituted).ok).toBe(false);

    const forged = load();
    forged.record.signature = "cd".repeat(64);
    const r = verifyProofBundle(forged);
    expect(r.checks.rowSignature).toBe(false);
    expect(r.ok).toBe(false);
  });

  it("a tampered Merkle sibling and a wrong root both fail", () => {
    const b = load();
    b.proof.siblings[0] = { ...b.proof.siblings[0]!, hash: "00".repeat(32) };
    expect(verifyProofBundle(b).checks.inclusion).toBe(false);

    const b2 = load();
    b2.checkpoint.merkleRoot = "ff".repeat(32);
    const r2 = verifyProofBundle(b2);
    expect(r2.checks.inclusion).toBe(false);
    expect(r2.checks.checkpointSignature).toBe(false); // the signed message covered the real root
  });

  it("primitives match the served values independently (hash recomputation + raw inclusion)", () => {
    const b = load();
    expect(payloadHash(b.record.payload)).toBe(b.record.payloadHash);
    expect(computeRowHash(b.record.prevHash, b.record.payloadHash)).toBe(b.record.rowHash);
    expect(verifyInclusion(b.record.rowHash, b.proof, b.checkpoint.merkleRoot!)).toBe(true);
  });
});
