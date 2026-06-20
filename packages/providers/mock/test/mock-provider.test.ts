import { describe, it, expect } from "vitest";
import {
  FailClosedError,
  asAgentId,
  providerEventToLedger,
  type EnforcementMode,
  type LedgerEvent,
  type ProviderEvent,
} from "@cosign/core";
import { definePolicy, type SpendAttempt } from "@cosign/policy";
import { MockProvider, type MockScenario } from "@cosign/provider-mock";

const AGENT = asAgentId("agent-1");
const spend = (over: Partial<SpendAttempt> = {}): SpendAttempt => ({
  amount: "50",
  asset: "USDC",
  counterparty: "0xTREASURY",
  venue: "base-sepolia",
  ...over,
});

async function provisioned(mode: EnforcementMode, scenario?: MockScenario) {
  const p = new MockProvider({ id: `mock-${mode}`, mode, ...(scenario ? { scenario } : {}) });
  const events: ProviderEvent[] = [];
  p.subscribe((e) => events.push(e));
  await p.provisionWallet(AGENT, { venue: "base-sepolia" });
  return { p, events };
}

const POLICY = definePolicy({
  asset: "USDC",
  perTxCap: "100",
  dailyCap: "120",
  allowlist: ["0xTREASURY"],
});

describe("MockProvider — enforcement + fail-closed scenarios", () => {
  const modes: EnforcementMode[] = ["native-session-caps", "pre-sign-policy", "onchain-policy"];

  // Semantic conformance: the SAME unified policy enforces identically across all three modes.
  for (const mode of modes) {
    it(`[${mode}] enforces the unified policy: at-cap allowed, over-cap blocked, off-allowlist blocked`, async () => {
      const { p } = await provisioned(mode);
      await p.applyPolicy(AGENT, POLICY);
      expect((await p.attemptSpend(AGENT, spend({ amount: "100" }))).outcome).toBe("allowed");
      expect((await p.attemptSpend(AGENT, spend({ amount: "101" }))).outcome).toBe("blocked");
      expect((await p.attemptSpend(AGENT, spend({ counterparty: "0xSTRANGER", amount: "1" }))).outcome).toBe("blocked");
    });
  }

  it("enforces a rolling daily cap across spends", async () => {
    const { p } = await provisioned("native-session-caps");
    await p.applyPolicy(AGENT, POLICY); // dailyCap 120
    expect((await p.attemptSpend(AGENT, spend({ amount: "100" }))).outcome).toBe("allowed");
    expect((await p.attemptSpend(AGENT, spend({ amount: "30" }))).outcome).toBe("blocked"); // 130 > 120
    expect((await p.attemptSpend(AGENT, spend({ amount: "20" }))).outcome).toBe("allowed"); // 120 == cap
  });

  it("applyPolicy that cannot confirm THROWS (fail-closed) — never silently keeps old policy", async () => {
    const { p } = await provisioned("onchain-policy", { applyPolicy: "unconfirmed" });
    await expect(p.applyPolicy(AGENT, POLICY)).rejects.toBeInstanceOf(FailClosedError);
  });

  it("[pre-sign] above approval threshold => needs_approval; approve() then allows", async () => {
    const { p, events } = await provisioned("pre-sign-policy");
    await p.applyPolicy(AGENT, definePolicy({ asset: "USDC", approvalThreshold: "200" }));
    const res = await p.attemptSpend(AGENT, spend({ amount: "300" }));
    expect(res.outcome).toBe("needs_approval");
    if (res.outcome !== "needs_approval") throw new Error("unreachable");
    await p.approve(res.approvalToken);
    expect(events.some((e) => e.type === "action_allowed")).toBe(true);
  });

  it("confirmed freeze stops subsequent spends", async () => {
    const { p } = await provisioned("native-session-caps");
    await p.applyPolicy(AGENT, POLICY);
    const fr = await p.freeze({ kind: "provider-all" });
    expect(fr.confirmed).toBe(true);
    expect((await p.attemptSpend(AGENT, spend({ amount: "10" }))).outcome).toBe("blocked");
  });

  it("UNCONFIRMED freeze leaves the agent dangerous until revokeSession (the escalation case)", async () => {
    const { p } = await provisioned("onchain-policy", { freeze: "unconfirmed", revoke: "confirm" });
    await p.applyPolicy(AGENT, POLICY);
    const fr = await p.freeze({ kind: "provider-all" });
    expect(fr.confirmed).toBe(false);
    // Still spends — the freeze didn't actually take.
    expect((await p.attemptSpend(AGENT, spend({ amount: "10" }))).outcome).toBe("allowed");
    // The harder kill stops it.
    await p.revokeSession(AGENT);
    expect((await p.attemptSpend(AGENT, spend({ amount: "10" }))).outcome).toBe("blocked");
  });

  it("freeze mechanism reflects the enforcement mode", async () => {
    expect((await (await provisioned("native-session-caps")).p.freeze({ kind: "provider-all" })).mechanism).toBe("caps-zeroed");
    expect((await (await provisioned("pre-sign-policy")).p.freeze({ kind: "provider-all" })).mechanism).toBe("policy-deny");
    expect((await (await provisioned("onchain-policy")).p.freeze({ kind: "provider-all" })).mechanism).toBe("onchain-guard");
  });

  it("emitted provider events map into the unified ledger vocabulary", async () => {
    const { p, events } = await provisioned("native-session-caps");
    await p.applyPolicy(AGENT, POLICY);
    await p.attemptSpend(AGENT, spend({ amount: "10" }));
    await p.attemptSpend(AGENT, spend({ amount: "999" }));

    const mapped = events
      .map((e) => providerEventToLedger(p.id, e))
      .filter((x): x is LedgerEvent => x !== null);
    const kinds = mapped.map((m) => m.kind);
    expect(kinds).toContain("policy_applied");
    expect(kinds).toContain("action_requested");
    expect(kinds).toContain("action_allowed");
    expect(kinds).toContain("action_blocked");
    // frozen/unfrozen are not double-logged (controller owns freeze auditing)
    await p.freeze({ kind: "provider-all" });
    const frozenEv = events.find((e) => e.type === "frozen")!;
    expect(providerEventToLedger(p.id, frozenEv)).toBeNull();
  });
});
