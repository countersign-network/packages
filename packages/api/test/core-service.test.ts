import { describe, it, expect } from "vitest";
import { asAgentId, type AgentId, type LedgerEvent } from "@cosign/core";
import { definePolicy, type SpendAttempt } from "@cosign/policy";
import { MockProvider, type MockScenario } from "@cosign/provider-mock";
import { CosignCore } from "@cosign/api";

const POLICY = definePolicy({ asset: "USDC", perTxCap: "100", dailyCap: "1000", allowlist: ["0xTREASURY"] });
const spend = (over: Partial<SpendAttempt> = {}): SpendAttempt => ({
  amount: "50",
  asset: "USDC",
  counterparty: "0xTREASURY",
  venue: "base-sepolia",
  ...over,
});

interface FleetSpec {
  id: string;
  mode: "native-session-caps" | "pre-sign-policy" | "onchain-policy";
  venue: string;
  scenario?: MockScenario;
}

async function buildFleet(specs: FleetSpec[]) {
  const core = new CosignCore({ freezeTimeoutMs: 300, escalateTimeoutMs: 300 });
  const providers: Record<string, MockProvider> = {};
  const agents: Record<string, AgentId> = {};
  for (const s of specs) {
    const p = new MockProvider({ id: s.id, mode: s.mode, ...(s.scenario ? { scenario: s.scenario } : {}) });
    providers[s.id] = p;
    await core.registerProvider(p);
    const agentId = asAgentId(`${s.id}-agent`);
    agents[s.id] = agentId;
    await core.provisionAgent(s.id, agentId, s.venue);
  }
  return { core, providers, agents };
}

const THREE: FleetSpec[] = [
  { id: "coinbase", mode: "native-session-caps", venue: "base-sepolia" },
  { id: "turnkey", mode: "pre-sign-policy", venue: "ethereum-sepolia" },
  { id: "openfort", mode: "onchain-policy", venue: "polygon-amoy" },
];

const kindsOf = (records: { payload: LedgerEvent }[]) => records.map((r) => r.payload.kind);

describe("CosignCore — the headline: 3 agents / 3 backends / 3 venues", () => {
  it("applies one policy everywhere, records every attempt, freezes all < 1s, ledger verifies", async () => {
    const { core, providers, agents } = await buildFleet(THREE);

    const applied = await core.applyPolicy(POLICY);
    expect(applied.applied).toHaveLength(3);
    expect(applied.failed).toHaveLength(0);

    // Each agent spends within policy, then trips a guard.
    expect((await providers.coinbase!.attemptSpend(agents.coinbase!, spend({ amount: "50" }))).outcome).toBe("allowed");
    expect((await providers.turnkey!.attemptSpend(agents.turnkey!, spend({ amount: "500" }))).outcome).toBe("blocked"); // over per-tx cap
    expect((await providers.openfort!.attemptSpend(agents.openfort!, spend({ counterparty: "0xSTRANGER", amount: "1" }))).outcome).toBe("blocked"); // off allowlist

    const t0 = Date.now();
    const report = await core.freezeAll("kill switch");
    const windowMs = Date.now() - t0;

    expect(report.allStopped).toBe(true);
    expect(report.providers.map((p) => p.outcome)).toEqual(["confirmed", "confirmed", "confirmed"]);
    expect(windowMs).toBeLessThan(1000);

    const records = await core.ledgerRecords();
    const kinds = kindsOf(records);
    expect(kinds.filter((k) => k === "policy_applied")).toHaveLength(3);
    expect(kinds).toContain("action_allowed");
    expect(kinds).toContain("action_blocked");
    expect(kinds.filter((k) => k === "freeze_result")).toHaveLength(3);
    expect(kinds).toContain("freeze_resolved");
    expect(await core.verifyLedger()).toBe(true);

    // After the freeze, a further spend attempt is blocked.
    expect((await providers.coinbase!.attemptSpend(agents.coinbase!, spend({ amount: "1" }))).outcome).toBe("blocked");
  });

  it("escalation: an unconfirmed freeze is rescued by revokeSession; ledger records the window", async () => {
    const { core } = await buildFleet([
      { id: "coinbase", mode: "native-session-caps", venue: "base-sepolia" },
      { id: "openfort", mode: "onchain-policy", venue: "polygon-amoy", scenario: { freeze: "unconfirmed", revoke: "confirm" } },
    ]);
    await core.applyPolicy(POLICY);
    const report = await core.freezeAll();

    expect(report.allStopped).toBe(true);
    const openfort = report.providers.find((p) => p.providerId === "openfort")!;
    expect(openfort.outcome).toBe("unconfirmed");
    expect(openfort.stopped).toBe(true);
    expect(kindsOf(await core.ledgerRecords())).toContain("escalation_revoke_session");
    expect(await core.verifyLedger()).toBe(true);
  });

  it("terminal danger: freeze unconfirmed AND revoke fails => still_dangerous, fail-closed", async () => {
    const { core } = await buildFleet([
      { id: "coinbase", mode: "native-session-caps", venue: "base-sepolia" },
      { id: "turnkey", mode: "pre-sign-policy", venue: "ethereum-sepolia", scenario: { freeze: "unconfirmed", revoke: "fail" } },
    ]);
    await core.applyPolicy(POLICY);
    const report = await core.freezeAll();

    expect(report.allStopped).toBe(false);
    const kinds = kindsOf(await core.ledgerRecords());
    expect(kinds).toContain("freeze_partial");
    expect(kinds).toContain("still_dangerous");
    expect(await core.verifyLedger()).toBe(true);
  });

  it("applyPolicy is fail-closed: a backend that can't confirm is reported failed + error-logged", async () => {
    const { core } = await buildFleet([
      { id: "coinbase", mode: "native-session-caps", venue: "base-sepolia" },
      { id: "openfort", mode: "onchain-policy", venue: "polygon-amoy", scenario: { applyPolicy: "unconfirmed" } },
    ]);
    const result = await core.applyPolicy(POLICY);
    expect(result.applied.map((a) => a.providerId)).toEqual(["coinbase"]);
    expect(result.failed.map((f) => f.providerId)).toEqual(["openfort"]);
    expect(kindsOf(await core.ledgerRecords())).toContain("error");
  });
});
