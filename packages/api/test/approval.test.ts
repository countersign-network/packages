import { describe, it, expect } from "vitest";
import type { AgentId, LedgerEvent } from "@countersign/core";
import { definePolicy } from "@countersign/policy";
import { CountersignCore, createDemoCore } from "@countersign/api";

const kindsOf = (records: { payload: LedgerEvent }[]) => records.map((r) => r.payload.kind);
const APPROVAL_POLICY = definePolicy({ asset: "USDC", perTxCap: "100000000", allowlist: ["0x000000000000000000000000000000000000dEaD"], approvalThreshold: "60000000" });
const bigSpend = { amount: "80000000", asset: "USDC", counterparty: "0x000000000000000000000000000000000000dEaD", venue: "base-sepolia" }; // > 60, <= 100

async function withApprovalPolicy(): Promise<{ core: CountersignCore; agent: AgentId }> {
  const { core, fleet } = await createDemoCore({ applyDefaultPolicy: false });
  await core.applyPolicy(APPROVAL_POLICY);
  return { core, agent: fleet[0]!.agentId };
}

describe("approval workflow", () => {
  it("evaluate -> needs_approval -> listed -> approve -> action_allowed", async () => {
    const { core, agent } = await withApprovalPolicy();
    const d = await core.evaluateSpend(agent, bigSpend);
    expect(d.outcome).toBe("needs_approval");
    expect(d.approvalToken).toBeTruthy();
    expect(core.approvals().approvals).toHaveLength(1);

    const r = await core.approve(d.approvalToken!);
    expect(r.outcome).toBe("approved");
    expect(core.approvals().approvals).toHaveLength(0); // resolved
    const kinds = kindsOf(await core.ledgerRecords());
    expect(kinds).toContain("approval_resolved");
    expect(kinds).toContain("action_allowed");
  });

  it("deny -> action_blocked", async () => {
    const { core, agent } = await withApprovalPolicy();
    const d = await core.evaluateSpend(agent, bigSpend);
    const r = await core.deny(d.approvalToken!, "looks off");
    expect(r.outcome).toBe("denied");
    expect(r.reason).toBe("looks off");
    const blocked = (await core.ledgerRecords()).map((x) => x.payload).find((p) => p.kind === "action_blocked");
    expect(blocked && blocked.kind === "action_blocked" && blocked.reason).toBe("looks off");
  });

  it("unknown token throws", async () => {
    const { core } = await withApprovalPolicy();
    await expect(core.approve("appr_nope")).rejects.toThrow(/unknown approval token/);
  });

  it("FAIL-CLOSED: a freeze overrides a pending approval — approving is rejected", async () => {
    const { core, agent } = await withApprovalPolicy();
    const d = await core.evaluateSpend(agent, bigSpend);
    await core.freezeAll("kill switch while an approval was pending");

    const r = await core.approve(d.approvalToken!);
    expect(r.outcome).toBe("denied");
    expect(r.reason).toContain("frozen");
    // the spend was blocked, never allowed
    const kinds = kindsOf(await core.ledgerRecords());
    expect(kinds).toContain("action_blocked");
  });
});
