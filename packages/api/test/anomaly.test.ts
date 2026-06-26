import { describe, it, expect } from "vitest";
import type { LedgerEvent } from "@countersign/core";
import { definePolicy } from "@countersign/policy";
import { AnomalyMonitor, createDemoCore } from "@countersign/api";

const kindsOf = (records: { payload: LedgerEvent }[]) => records.map((r) => r.payload.kind);
const anomalies = (records: { payload: LedgerEvent }[]) =>
  records.map((r) => r.payload).filter((p): p is Extract<LedgerEvent, { kind: "anomaly_detected" }> => p.kind === "anomaly_detected");

const spend = (amount: string, counterparty = "0xTREASURY") => ({ amount, asset: "USDC", counterparty, venue: "base-sepolia" });
// The auto-freeze / anomaly record is fired-and-forgotten from the spend path; let it settle.
const settle = () => new Promise((r) => setTimeout(r, 50));

describe("AnomalyMonitor — heuristic circuit breakers", () => {
  it("velocity rule AUTO-FREEZES after too many rapid spends", async () => {
    const { core, fleet } = await createDemoCore(); // perTxCap 100 USDC, allowlist [0xTREASURY]
    const monitor = new AnomalyMonitor(core, { velocity: { maxSpends: 3, windowMs: 60_000, action: "freeze" } });
    const cb = fleet[0]!; // coinbase / payments-bot

    for (let i = 0; i < 4; i++) await cb.provider.attemptSpend(cb.agentId, spend("10000000")); // 4 > 3 -> trip
    await settle();

    const recs = await core.ledgerRecords();
    expect(anomalies(recs).some((x) => x.rule === "velocity" && x.action === "freeze")).toBe(true);
    expect(kindsOf(recs)).toContain("freeze_resolved"); // the auto-freeze fired
    monitor.stop();
  });

  it("blocked-burst rule fires on an agent hammering its limits (alert, no freeze)", async () => {
    const { core, fleet } = await createDemoCore();
    const monitor = new AnomalyMonitor(core, { blockedBurst: { maxBlocked: 2, windowMs: 60_000, action: "alert" } });
    const cb = fleet[0]!;

    for (let i = 0; i < 3; i++) await cb.provider.attemptSpend(cb.agentId, spend("500000000")); // 3 blocks > 2
    await settle();

    const recs = await core.ledgerRecords();
    expect(anomalies(recs).some((x) => x.rule === "blocked_burst")).toBe(true);
    expect(kindsOf(recs)).not.toContain("freeze_resolved");
    monitor.stop();
  });

  it("new-counterparty rule flags a first-seen payee (after a baseline is established)", async () => {
    const { core, fleet } = await createDemoCore({ applyDefaultPolicy: false });
    await core.applyPolicy(definePolicy({ asset: "USDC", perTxCap: "100000000", allowlist: ["0xA", "0xB"] }), fleet[0]!.agentId);
    const monitor = new AnomalyMonitor(core, { newCounterparty: { action: "alert" } });
    const cb = fleet[0]!;

    await cb.provider.attemptSpend(cb.agentId, spend("1000000", "0xA")); // baseline — no flag
    await cb.provider.attemptSpend(cb.agentId, spend("1000000", "0xB")); // new payee — flag
    await settle();

    expect(anomalies(await core.ledgerRecords()).filter((x) => x.rule === "new_counterparty")).toHaveLength(1);
    monitor.stop();
  });

  it("does not re-freeze on every event once disarmed", async () => {
    const { core, fleet } = await createDemoCore();
    const monitor = new AnomalyMonitor(core, { velocity: { maxSpends: 2, windowMs: 60_000, action: "freeze" } });
    const cb = fleet[0]!;

    for (let i = 0; i < 6; i++) await cb.provider.attemptSpend(cb.agentId, spend("10000000"));
    await settle();

    expect(kindsOf(await core.ledgerRecords()).filter((k) => k === "freeze_requested").length).toBe(1);
    monitor.stop();
  });
});
