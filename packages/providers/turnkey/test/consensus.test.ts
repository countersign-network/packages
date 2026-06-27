import { describe, it, expect } from "vitest";
import { asAgentId } from "@countersign/core";
import { definePolicy } from "@countersign/policy";
import { TurnkeyProvider, type TurnkeyConfig } from "../src/index";

/**
 * Offline unit test of the Turnkey native consensus (human-approval) gate — no creds; a fake Turnkey
 * client is injected by stubbing the lazy client() via the config + a captured createPolicy.
 *
 * The gap this guards: an over-threshold spend must hit Turnkey's NATIVE consensus gate
 * (ACTIVITY_STATUS_CONSENSUS_NEEDED) when an approver is configured — and must NOT be pushed with a
 * placeholder approver when none is (it stays Countersign-layer-enforced, invariant #5).
 */
function fakeProvider(config: TurnkeyConfig, calls: Array<Record<string, unknown>>): TurnkeyProvider {
  // apiPublicKey is read by rootApiPublicKey() to build the sub-org root user (no network); the
  // network client is stubbed below, so no real creds are needed.
  const p = new TurnkeyProvider({ apiPublicKey: "pub_test", ...config });
  // Stub the credentialed client with a fake that records createPolicy + satisfies provisionWallet.
  (p as unknown as { client: () => unknown }).client = () => ({
    createSubOrganization: async () => ({ subOrganizationId: "so_1", wallet: { addresses: ["0x000000000000000000000000000000000000c0de"] } }),
    createUsers: async () => ({ userIds: ["user_agent"] }),
    createPolicy: async (args: Record<string, unknown>) => {
      calls.push(args);
      return { policyId: `pol_${calls.length}` };
    },
  });
  return p;
}

const policyWithApproval = definePolicy({
  asset: "USDC",
  perTxCap: "100",
  approvalThreshold: "60", // spends over 60 need human co-approval
});

describe("Turnkey consensus gate (native human-approval)", () => {
  it("with approver ids configured, installs the consensus clause natively bound to the real id(s)", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const p = fakeProvider({ approverUserIds: ["approver-123", "approver-456"] }, calls);
    const a = asAgentId("a");
    await p.provisionWallet(a, { venue: "polygon-amoy" });
    await p.applyPolicy(a, policyWithApproval);

    const consensusClause = calls.find((c) => typeof c["consensus"] === "string");
    expect(consensusClause).toBeDefined();
    const consensus = consensusClause!["consensus"] as string;
    expect(consensus).toContain("u.id == 'approver-123'");
    expect(consensus).toContain("u.id == 'approver-456'");
    expect(consensus).not.toContain("HUMAN_APPROVER"); // placeholder fully substituted
  });

  it("with NO approver configured, does NOT push the consensus clause (stays Countersign-layer)", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const p = fakeProvider({}, calls);
    const a = asAgentId("a");
    await p.provisionWallet(a, { venue: "polygon-amoy" });
    await p.applyPolicy(a, policyWithApproval);

    expect(calls.some((c) => typeof c["consensus"] === "string")).toBe(false); // no placeholder ever pushed
  });

  it("refuses to embed an unsafe approver id (CEL-injection defense)", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const p = fakeProvider({ approverUserIds: ["x' || true || '"] }, calls);
    const a = asAgentId("a");
    await p.provisionWallet(a, { venue: "polygon-amoy" });
    await expect(p.applyPolicy(a, policyWithApproval)).rejects.toThrow(/unsafe approver/i);
  });
});
