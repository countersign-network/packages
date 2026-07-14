import { describe, it, expect } from "vitest";
import { UnifiedPolicySchema, parsePolicy, definePolicy } from "../src/policy";

const ADDR = "0x000000000000000000000000000000000000dEaD";
const base = { schemaVersion: 1 as const, asset: "USDC" };

/**
 * The PUBLIC UnifiedPolicy schema is the single most important contract in the front door — it is the
 * boundary that rejects hostile input (CEL-injection via non-hex addresses, malformed amounts) before
 * the proprietary compiler ever sees it. It previously had no test. These pin the validation guarantees.
 */
describe("UnifiedPolicy schema — accepts well-formed policy", () => {
  it("accepts a full policy and round-trips through parsePolicy", () => {
    const p = parsePolicy({ ...base, perTxCap: "100", dailyCap: "1000", allowlist: [ADDR], denylist: [], approvalThreshold: "50", frozen: false, venues: ["base-sepolia"] });
    expect(p.asset).toBe("USDC");
    expect(p.allowlist).toEqual([ADDR]);
  });
  it("definePolicy returns the canonical v3 shape (v1/v2 input normalizes)", () => {
    expect(definePolicy({ asset: "USDC", perTxCap: "1" }).schemaVersion).toBe(3);
    // a venues ARRAY marks v1 input — still accepted, normalized to the v2 allow-list
    expect(definePolicy({ asset: "USDC", venues: ["base-sepolia"] }).venues).toEqual({ allow: ["base-sepolia"] });
  });
});

describe("UnifiedPolicy schema — rejects malformed input (fail-closed at the boundary)", () => {
  it("rejects UNKNOWN keys (strictObject — no smuggled fields)", () => {
    expect(() => parsePolicy({ ...base, bogus: 1 })).toThrow();
  });
  it("enforces a KNOWN schemaVersion (1, 2, or 3) and the right venues shape per version", () => {
    expect(() => parsePolicy({ asset: "USDC" })).toThrow(); // missing version
    expect(() => parsePolicy({ ...base, schemaVersion: 4 })).toThrow(); // unknown version
    expect(() => parsePolicy({ ...base, schemaVersion: "1" })).toThrow(); // string, not a literal
    // v2 and v3 ARE accepted — with the rules-block venues shape (an array is the v1 shape)
    expect(parsePolicy({ ...base, schemaVersion: 2 }).schemaVersion).toBe(3);
    expect(parsePolicy({ ...base, schemaVersion: 3 }).schemaVersion).toBe(3);
    expect(() => parsePolicy({ ...base, schemaVersion: 2, venues: ["base-sepolia"] })).toThrow();
    expect(() => parsePolicy({ ...base, schemaVersion: 1, venues: { allow: ["base-sepolia"] } })).toThrow();
  });
  it("requires a non-empty asset", () => {
    expect(() => parsePolicy({ schemaVersion: 1, asset: "" })).toThrow();
  });
  it("rejects non-hex / wrong-length addresses in allow/denylist (CEL-injection defense)", () => {
    for (const bad of ["0xABC", "not-an-address", ADDR.slice(0, -1), ADDR + "00", "0xZZ00000000000000000000000000000000000000", "0x" + "g".repeat(40), "0x1234567890' || true || '"]) {
      expect(() => parsePolicy({ ...base, allowlist: [bad] })).toThrow();
      expect(() => parsePolicy({ ...base, denylist: [bad] })).toThrow();
    }
  });
  it("rejects negative / decimal / empty / hex amounts on every amount field", () => {
    for (const field of ["perTxCap", "dailyCap", "approvalThreshold"] as const) {
      for (const bad of ["-1", "1.5", "", "0x10", "1e9", " 10"]) {
        expect(() => parsePolicy({ ...base, [field]: bad })).toThrow();
      }
    }
  });
  it("accepts a huge amount as a string (no JS-number overflow)", () => {
    const huge = "123456789012345678901234567890";
    expect(parsePolicy({ ...base, perTxCap: huge }).perTxCap).toBe(huge);
  });
});

describe("UnifiedPolicy schema — allowlist sentinel semantics", () => {
  it("preserves an EMPTY allowlist (the deny-all sentinel) rather than stripping it", () => {
    const p = parsePolicy({ ...base, allowlist: [] });
    expect(p.allowlist).toEqual([]); // must survive — the evaluator reads [] as 'deny everyone'
  });
  it("an ABSENT allowlist stays undefined (any counterparty allowed, subject to other rules)", () => {
    expect(parsePolicy(base).allowlist).toBeUndefined();
  });
});

describe("UnifiedPolicy schema — direct safeParse surface", () => {
  it("UnifiedPolicySchema.safeParse reports success/failure without throwing", () => {
    expect(UnifiedPolicySchema.safeParse({ ...base }).success).toBe(true);
    expect(UnifiedPolicySchema.safeParse({ ...base, perTxCap: "-1" }).success).toBe(false);
  });
});
