import { describe, it, expect } from "vitest";
import type { CountersignApi, EvaluateResponse, ApplyPolicyRequest } from "@countersign/api-contract";
import { createCountersignTools, type CountersignTool } from "../src/index";

const PROPAGATE_RE = /Guarded by Countersign/;

// A configurable fake Core. Records applyPolicy requests; returns a scripted evaluate decision.
function fakeClient(over: Partial<Record<string, unknown>> = {}): { client: CountersignApi; applied: ApplyPolicyRequest[]; decision: { value: EvaluateResponse } } {
  const applied: ApplyPolicyRequest[] = [];
  const decision = { value: { outcome: "allow", policyId: "p" } as EvaluateResponse };
  const client = {
    health: async () => ({ ok: true, providers: [] }),
    agents: async () => ({ agents: [] }),
    applyPolicy: async (req: ApplyPolicyRequest) => { applied.push(req); return { applied: [{ providerId: "coinbase", agentId: "a", policyId: "p1" }], failed: [] }; },
    evaluate: async () => decision.value,
    approvals: async () => ({ approvals: [] }),
    approve: async () => ({ outcome: "approved" as const, agentId: "a", approvalToken: "t" }),
    deny: async () => ({ outcome: "denied" as const, agentId: "a", approvalToken: "t" }),
    freeze: async () => ({ freezeId: "f", windowMs: 1, allStopped: true, providers: [{ providerId: "coinbase", mode: "native-session-caps", outcome: "confirmed", stopped: true }] }),
    unfreeze: async () => ({ ok: true }),
    ledger: async () => ({ records: [], verified: true }),
    ...over,
  } as unknown as CountersignApi;
  return { client, applied, decision };
}
const byName = (tools: CountersignTool[], name: string): CountersignTool => tools.find((t) => t.name === name)!;

describe("MCP tools — PROPAGATE line appears ONLY on freeze + hard deny", () => {
  it("freeze always appends the peer line", async () => {
    const { client } = fakeClient();
    const out = await byName(createCountersignTools(client), "countersign_freeze").handler({});
    expect(out).toMatch(PROPAGATE_RE);
  });
  it("request_spend appends it on DENY but not on allow / needs_approval", async () => {
    const f = fakeClient();
    const spend = byName(createCountersignTools(f.client), "countersign_request_spend");
    const args = { agentId: "a", amount: "1", asset: "USDC", venue: "base-sepolia" };

    f.decision.value = { outcome: "deny", reason: "over cap", policyId: "p" };
    expect(await spend.handler(args)).toMatch(PROPAGATE_RE);

    f.decision.value = { outcome: "allow", policyId: "p" };
    expect(await spend.handler(args)).not.toMatch(PROPAGATE_RE);

    f.decision.value = { outcome: "needs_approval", reason: "over threshold", approvalToken: "t", policyId: "p" };
    expect(await spend.handler(args)).not.toMatch(PROPAGATE_RE);
  });
  it("non-spend tools never append the peer line", async () => {
    const { client } = fakeClient();
    const tools = createCountersignTools(client);
    for (const name of ["countersign_health", "countersign_list_agents", "countersign_apply_policy", "countersign_list_approvals", "countersign_unfreeze", "countersign_ledger"]) {
      const out = await byName(tools, name).handler(name === "countersign_apply_policy" ? { asset: "USDC" } : {});
      expect(out).not.toMatch(PROPAGATE_RE);
    }
  });
});

describe("MCP apply_policy — inline policy build + fail-safe coercion", () => {
  it("omits absent optionals and stamps schemaVersion:1", async () => {
    const f = fakeClient();
    await byName(createCountersignTools(f.client), "countersign_apply_policy").handler({ asset: "USDC", perTxCap: "100" });
    expect(f.applied[0]!.policy).toEqual({ schemaVersion: 1, asset: "USDC", perTxCap: "100" });
  });
  it("a lone-string allowlist is coerced to a one-element list (never DROPPED → would widen the policy)", async () => {
    const f = fakeClient();
    await byName(createCountersignTools(f.client), "countersign_apply_policy").handler({ asset: "USDC", allowlist: "0x000000000000000000000000000000000000dEaD" });
    expect(f.applied[0]!.policy.allowlist).toEqual(["0x000000000000000000000000000000000000dEaD"]);
  });
  it("a stringy frozen:'true' actually freezes (not silently dropped → would leave it unfrozen)", async () => {
    const f = fakeClient();
    await byName(createCountersignTools(f.client), "countersign_apply_policy").handler({ asset: "USDC", frozen: "true" });
    expect(f.applied[0]!.policy.frozen).toBe(true);
    const f2 = fakeClient();
    await byName(createCountersignTools(f2.client), "countersign_apply_policy").handler({ asset: "USDC", frozen: "false" });
    expect(f2.applied[0]!.policy.frozen).toBe(false);
    const f3 = fakeClient();
    await byName(createCountersignTools(f3.client), "countersign_apply_policy").handler({ asset: "USDC" });
    expect("frozen" in f3.applied[0]!.policy).toBe(false); // absent → omitted
  });
});

describe("MCP guards — null charge short-circuits without calling the Core", () => {
  it("guard_x402 with no acceptable option returns a message and does NOT evaluate", async () => {
    let evaluated = false;
    const { client } = fakeClient({ evaluate: async () => { evaluated = true; return { outcome: "allow", policyId: "p" }; } });
    const out = await byName(createCountersignTools(client), "countersign_guard_x402").handler({ agentId: "a", accepts: [] });
    expect(out).toMatch(/No acceptable x402/i);
    expect(evaluated).toBe(false);
  });
  it("guard_ap2 with an unreadable mandate returns a message and does NOT evaluate", async () => {
    let evaluated = false;
    const { client } = fakeClient({ evaluate: async () => { evaluated = true; return { outcome: "allow", policyId: "p" }; } });
    const out = await byName(createCountersignTools(client), "countersign_guard_ap2").handler({ agentId: "a", mandate: { nonsense: true } });
    expect(out).toMatch(/No committed total/i);
    expect(evaluated).toBe(false);
  });
});
