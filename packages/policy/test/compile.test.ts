import { describe, it, expect } from "vitest";
import { compile, definePolicy, parsePolicy, type CoinbaseControls, type OpenfortOnchainPolicy, type TurnkeyPolicyDoc, type UnifiedPolicy } from "@countersign/policy";

const FULL = definePolicy({
  asset: "USDC",
  perTxCap: "100000000", // 100 USDC (6-dec)
  dailyCap: "500000000", // 500 USDC
  allowlist: ["0x000000000000000000000000000000000000dEaD"],
  denylist: ["0x000000000000000000000000000000000000bad6"],
  approvalThreshold: "200000000",
  venues: ["base-sepolia"],
});

const unsupportedFields = (n: { unsupported: { field: string }[] }) => n.unsupported.map((u) => u.field).sort();

describe("compile — one policy, three native shapes (the core IP)", () => {
  it("Coinbase (native-session-caps): daily cap -> spend permission, per-tx+allow/deny -> policy rules", () => {
    const c = compile(FULL, "native-session-caps") as CoinbaseControls;
    expect(c.provider).toBe("coinbase");
    expect(c.spendPermission).toEqual({ token: "USDC", allowance: "500000000", periodInDays: 1 });
    // first rule rejects the denylist, then an accept rule carries per-tx cap + allowlist + network
    expect(c.policy!.rules[0]).toMatchObject({ action: "reject" });
    const accept = c.policy!.rules.find((r) => r.action === "accept")!;
    expect(accept.criteria).toEqual([
      { type: "ethValue", ethValue: "100000000", operator: "<=" },
      { type: "evmAddress", addresses: ["0x000000000000000000000000000000000000dEaD"], operator: "in" },
      { type: "evmNetwork", networks: ["base-sepolia"], operator: "in" },
    ]);
    // approval threshold has no native counterpart on a caps-only backend
    expect(unsupportedFields(c)).toEqual(["approvalThreshold"]);
  });

  it("Turnkey (pre-sign-policy): CEL conditions + a consensus policy for the approval gate", () => {
    const t = compile(FULL, "pre-sign-policy") as TurnkeyPolicyDoc;
    expect(t.provider).toBe("turnkey");
    const allow = t.policies.find((p) => p.policyName === "agent-spend-allow")!;
    expect(allow.condition).toBe("eth.tx.value <= 100000000 && eth.tx.to in ['0x000000000000000000000000000000000000dEaD'] && eth.tx.chain_id in [84532]");
    const denyl = t.policies.find((p) => p.policyName === "denylist")!;
    expect(denyl.effect).toBe("EFFECT_DENY");
    const approval = t.policies.find((p) => p.policyName === "approval-threshold")!;
    expect(approval.consensus).toContain("approvers.any");
    expect(approval.condition).toBe("eth.tx.value > 200000000");
    // Turnkey CEL is stateless -> can't do a rolling daily cap natively
    expect(unsupportedFields(t)).toEqual(["dailyCap"]);
  });

  it("Openfort (onchain-policy): allowlist -> setCanCall, daily cap -> tokenSpend; per-tx/deny/approval unsupported", () => {
    const o = compile(FULL, "onchain-policy") as OpenfortOnchainPolicy;
    expect(o.provider).toBe("openfort");
    expect(o.canCall).toEqual([{ target: "0x000000000000000000000000000000000000dEaD", selector: "*" }]);
    expect(o.tokenSpend).toEqual({ token: "USDC", limit: "500000000", period: "day" });
    expect(unsupportedFields(o)).toEqual(["approvalThreshold", "denylist", "perTxCap"]);
  });

  it("frozen policy sets freeze on every backend", () => {
    const p = definePolicy({ asset: "USDC", frozen: true });
    expect(compile(p, "native-session-caps").freeze).toBe(true);
    expect(compile(p, "pre-sign-policy").freeze).toBe(true);
    expect(compile(p, "onchain-policy").freeze).toBe(true);
  });

  it("empty allowlist => deny-all on each backend", () => {
    const p = definePolicy({ asset: "USDC", allowlist: [] });
    const c = compile(p, "native-session-caps") as CoinbaseControls;
    expect(c.policy!.rules).toEqual([{ action: "reject", operation: "signEvmTransaction", criteria: [] }]);
    const t = compile(p, "pre-sign-policy") as TurnkeyPolicyDoc;
    expect(t.policies.some((x) => x.policyName === "empty-allowlist-deny-all")).toBe(true);
    const o = compile(p, "onchain-policy") as OpenfortOnchainPolicy;
    expect(o.canCall).toEqual([]);
  });
});

describe("policy injection defense — addresses must be hex (CEL-injection vector)", () => {
  it("parse rejects non-hex / CEL-metachar allowlist entries; accepts a real address", () => {
    expect(() => parsePolicy({ schemaVersion: 1, asset: "USDC", allowlist: ["0xX'] || ['evil"] })).toThrow();
    expect(() => parsePolicy({ schemaVersion: 1, asset: "USDC", allowlist: ["0xTREASURY"] })).toThrow();
    expect(() => parsePolicy({ schemaVersion: 1, asset: "USDC", allowlist: ["0x000000000000000000000000000000000000dEaD"] })).not.toThrow();
  });

  it("the Turnkey compiler refuses a non-hex address even if the schema is bypassed", () => {
    const crafted = { schemaVersion: 1, asset: "USDC", allowlist: ["0xBEEF'] || eth.tx.value >= ['0"] } as unknown as UnifiedPolicy;
    expect(() => compile(crafted, "pre-sign-policy")).toThrow(/non-hex address/i);
  });
});
