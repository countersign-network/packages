import { describe, it, expect } from "vitest";
import { parsePolicy, definePolicy, normalizePolicy, type UnifiedPolicyV1 } from "../src/policy";

/** P1.1 — schema v2 (venue rules block) with a versioned v1 migration. */
describe("UnifiedPolicy schema v2 + v1 migration", () => {
  it("accepts a v1 policy and normalizes its venues array to the v2 allow-list", () => {
    const p = parsePolicy({ schemaVersion: 1, asset: "USDC", perTxCap: "100", venues: ["base-sepolia"] });
    expect(p.schemaVersion).toBe(2);
    expect(p.venues).toEqual({ allow: ["base-sepolia"] });
    expect(p.perTxCap).toBe("100");
  });

  it("a v1 policy WITHOUT venues normalizes without inventing a venues block", () => {
    const p = parsePolicy({ schemaVersion: 1, asset: "USDC" });
    expect(p.schemaVersion).toBe(2);
    expect(p.venues).toBeUndefined();
  });

  it("accepts a v2 policy with the full venue-rules block", () => {
    const p = parsePolicy({
      schemaVersion: 2,
      asset: "USDC",
      venues: {
        allow: ["base-sepolia"],
        deny: ["polygon-amoy"],
        listingAllowlist: ["https://api.example.com/paid"],
        perVenueCaps: { "base-sepolia": { perTx: "100", dailyRolling: "500" } },
      },
    });
    expect(p.venues?.deny).toEqual(["polygon-amoy"]);
    expect(p.venues?.perVenueCaps?.["base-sepolia"]?.perTx).toBe("100");
  });

  it("rejects invalid policies with actionable errors (bad amounts, unknown keys, wrong venues shape per version)", () => {
    // v2 with a v1-style venues array — wrong shape for the version
    expect(() => parsePolicy({ schemaVersion: 2, asset: "USDC", venues: ["base-sepolia"] })).toThrow();
    // v1 with a v2-style venues block — wrong shape for the version
    expect(() => parsePolicy({ schemaVersion: 1, asset: "USDC", venues: { allow: ["base-sepolia"] } })).toThrow();
    // per-venue cap must be a base-unit integer string
    expect(() => parsePolicy({ schemaVersion: 2, asset: "USDC", venues: { perVenueCaps: { x: { perTx: "1.5" } } } })).toThrow(/amount/);
    // strictObject: unknown keys rejected
    expect(() => parsePolicy({ schemaVersion: 2, asset: "USDC", venues: { allowed: ["typo"] } })).toThrow();
    // unknown schemaVersion
    expect(() => parsePolicy({ schemaVersion: 3, asset: "USDC" })).toThrow();
  });

  it("definePolicy infers the version from the venues shape and always returns canonical v2", () => {
    const fromArray = definePolicy({ asset: "USDC", venues: ["base-sepolia"] });
    expect(fromArray.schemaVersion).toBe(2);
    expect(fromArray.venues).toEqual({ allow: ["base-sepolia"] });
    const fromBlock = definePolicy({ asset: "USDC", venues: { deny: ["polygon-amoy"] } });
    expect(fromBlock.venues?.deny).toEqual(["polygon-amoy"]);
    const without = definePolicy({ asset: "USDC" });
    expect(without.schemaVersion).toBe(2);
  });

  it("normalizePolicy is a no-op for v2 and preserves every common field from v1", () => {
    const v1: UnifiedPolicyV1 = {
      schemaVersion: 1, asset: "USDC", perTxCap: "1", dailyCap: "2",
      allowlist: ["0x000000000000000000000000000000000000dEaD"],
      denylist: ["0x000000000000000000000000000000000000bEEF"],
      approvalThreshold: "1", frozen: false, venues: ["base-sepolia"],
    };
    const n = normalizePolicy(v1);
    expect(n).toMatchObject({
      schemaVersion: 2, asset: "USDC", perTxCap: "1", dailyCap: "2",
      approvalThreshold: "1", frozen: false, venues: { allow: ["base-sepolia"] },
    });
    const v2 = definePolicy({ asset: "USDC", venues: { allow: ["x"] } });
    expect(normalizePolicy(v2)).toBe(v2);
  });
});
