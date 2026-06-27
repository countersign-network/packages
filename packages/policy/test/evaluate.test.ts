import { describe, it, expect } from "vitest";
import { definePolicy, evaluatePolicy, type SpendAttempt } from "@countersign/policy";

const spend = (over: Partial<SpendAttempt> = {}): SpendAttempt => ({
  amount: "50",
  asset: "USDC",
  counterparty: "0x000000000000000000000000000000000000dEaD",
  venue: "base-sepolia",
  ...over,
});

describe("evaluatePolicy — the executable policy semantics", () => {
  it("frozen denies everything", () => {
    const p = definePolicy({ asset: "USDC", frozen: true, allowlist: ["0x000000000000000000000000000000000000dEaD"] });
    expect(evaluatePolicy(p, spend()).outcome).toBe("deny");
  });

  it("denylist wins over allowlist", () => {
    const p = definePolicy({ asset: "USDC", allowlist: ["0x000000000000000000000000000000000000bad0"], denylist: ["0x000000000000000000000000000000000000bad0"] });
    expect(evaluatePolicy(p, spend({ counterparty: "0x000000000000000000000000000000000000bad0" })).outcome).toBe("deny");
  });

  it("absent allowlist allows any counterparty; empty allowlist denies all", () => {
    expect(evaluatePolicy(definePolicy({ asset: "USDC" }), spend({ counterparty: "0x000000000000000000000000000000000000a11a" })).outcome).toBe("allow");
    const denyAll = definePolicy({ asset: "USDC", allowlist: [] });
    expect(evaluatePolicy(denyAll, spend({ counterparty: "0x000000000000000000000000000000000000a11a" })).outcome).toBe("deny");
  });

  it("per-tx cap: allows at the cap, denies one above", () => {
    const p = definePolicy({ asset: "USDC", perTxCap: "100" });
    expect(evaluatePolicy(p, spend({ amount: "100" })).outcome).toBe("allow");
    expect(evaluatePolicy(p, spend({ amount: "101" })).outcome).toBe("deny");
  });

  it("daily cap considers running spend", () => {
    const p = definePolicy({ asset: "USDC", dailyCap: "100" });
    expect(evaluatePolicy(p, spend({ amount: "60" }), { dailySpent: "50" }).outcome).toBe("deny");
    expect(evaluatePolicy(p, spend({ amount: "40" }), { dailySpent: "50" }).outcome).toBe("allow");
  });

  it("approval threshold: above => needs_approval, at threshold => allow", () => {
    const p = definePolicy({ asset: "USDC", approvalThreshold: "200" });
    expect(evaluatePolicy(p, spend({ amount: "200" })).outcome).toBe("allow");
    expect(evaluatePolicy(p, spend({ amount: "201" })).outcome).toBe("needs_approval");
  });

  it("venue not on the list is denied", () => {
    const p = definePolicy({ asset: "USDC", venues: ["base-sepolia"] });
    expect(evaluatePolicy(p, spend({ venue: "polygon-amoy" })).outcome).toBe("deny");
  });

  it("caps apply only to the policy's asset", () => {
    const p = definePolicy({ asset: "USDC", perTxCap: "100" });
    // A spend in a different asset isn't governed by this asset's cap.
    expect(evaluatePolicy(p, spend({ asset: "DAI", amount: "999999" })).outcome).toBe("allow");
  });
});
