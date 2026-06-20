/**
 * THE HEADLINE DEMO. Run with: pnpm demo
 *
 * Three agents, three backends (three EnforcementModes), three venues. One unified policy compiled
 * to each backend's native controls. Agents spend within policy and get blocked when they breach.
 * Then ONE freeze stops all three in well under a second. One hash-chained ledger shows every
 * attempt. Finally, a chaos run proves the system is fail-closed when a backend won't confirm a stop.
 *
 * All against faithful mocks — no credentials. Swap a MockProvider for a real adapter and the same
 * orchestration runs against live testnet wallets.
 */

import type { LedgerEvent } from "@cosign/core";
import { compile, definePolicy, type SpendAttempt, type UnifiedPolicy } from "@cosign/policy";
import { buildMockFleet } from "./fleet";
import { SpendingAgent } from "./agent";

const line = (s = "") => console.log(s);
const rule = () => line("─".repeat(74));
function section(title: string): void {
  line();
  rule();
  line(`  ${title}`);
  rule();
}

const usdc = (base: string) => `${(Number(BigInt(base)) / 1e6).toFixed(2)} USDC`;
const ms = (n: number) => `${n}ms`;

const TREASURY = "0xTREASURY";
const STRANGER = "0xSTRANGER";

const POLICY: UnifiedPolicy = definePolicy({
  asset: "USDC",
  perTxCap: "100000000", // 100 USDC
  dailyCap: "100000000", // 100 USDC (deliberately tight, to show the rolling daily gate)
  allowlist: [TREASURY],
  approvalThreshold: "60000000", // > 60 USDC requires human approval
});

function describeNative(native: ReturnType<typeof compile>): string[] {
  const lines: string[] = [];
  if (native.provider === "coinbase") {
    lines.push(
      `spendPermission: ${native.spendPermission ? `${usdc(native.spendPermission.allowance)} / ${native.spendPermission.periodInDays}d` : "—"}`,
    );
    lines.push(`policy.rules: ${native.policy?.rules.map((r) => `${r.action}(${r.criteria.map((c) => c.type).join("+") || "all"})`).join(", ") ?? "—"}`);
  } else if (native.provider === "turnkey") {
    for (const p of native.policies) lines.push(`${p.effect} ${p.policyName}: ${p.condition}${p.consensus ? `  [consensus: ${p.consensus}]` : ""}`);
  } else {
    lines.push(`canCall: ${native.canCall.map((c) => c.target).join(", ") || "—"}`);
    lines.push(`tokenSpend: ${native.tokenSpend ? `${usdc(native.tokenSpend.limit)} / ${native.tokenSpend.period}` : "—"}`);
  }
  if (native.unsupported.length > 0) {
    lines.push(`⚠ NOT enforceable natively -> Cosign enforces: ${native.unsupported.map((u) => u.field).join(", ")}`);
  }
  return lines;
}

function formatEvent(e: LedgerEvent): string {
  switch (e.kind) {
    case "policy_applied":
      return `policy applied to ${e.agentId} (${e.policyId})`;
    case "action_requested":
      return `→ ${e.agentId} requests ${usdc(e.action.amount)} to ${e.action.counterparty ?? "?"}`;
    case "action_allowed":
      return `  ✓ ALLOWED ${e.agentId} ${usdc(e.action.amount)}`;
    case "action_blocked":
      return `  ✗ BLOCKED ${e.agentId} ${usdc(e.action.amount)} — ${e.reason}`;
    case "needs_approval":
      return `  ⏸ NEEDS APPROVAL ${e.agentId} ${usdc(e.action.amount)} — ${e.reason}`;
    case "approval_resolved":
      return `  ↳ approval ${e.decision.toUpperCase()} (${e.approvalToken})`;
    case "freeze_requested":
      return `FREEZE requested across [${e.targets.join(", ")}] — ${e.reason}`;
    case "freeze_result":
      return `  freeze ${e.providerId} (${e.mode}): ${e.outcome.toUpperCase()}${e.mechanism ? ` via ${e.mechanism}` : ""} (${ms(e.latencyMs)})`;
    case "escalation_revoke_session":
      return `  ↳ ESCALATE revokeSession ${e.providerId}/${e.agentId}: ${e.outcome} (${ms(e.latencyMs)})`;
    case "freeze_partial":
      return `  partial: confirmed [${e.confirmed.join(", ")}] dangerous [${e.dangerous.join(", ")}]`;
    case "freeze_resolved":
      return `FREEZE RESOLVED — all ${e.providerCount} backends stopped in ${ms(e.windowMs)}`;
    case "still_dangerous":
      return `STILL DANGEROUS after ${ms(e.windowMs)}: ${e.dangerous.map((d) => `${d.providerId}${d.agentId ? `/${d.agentId}` : ""}`).join(", ")}`;
    case "session_revoked":
      return `session revoked ${e.agentId}`;
    case "error":
      return `! error ${e.providerId ?? ""} ${e.message}`;
    default:
      return "(event)";
  }
}

async function dumpLedger(core: Awaited<ReturnType<typeof buildMockFleet>>["core"]): Promise<void> {
  const records = await core.ledgerRecords();
  for (const r of records) line(`  #${String(r.index).padStart(2, "0")} ${formatEvent(r.payload)}`);
  const ok = await core.verifyLedger();
  line();
  line(`  hash-chain verified: ${ok ? "✓ INTACT" : "✗ TAMPERED"}  (${records.length} entries, append-only)`);
}

async function headline(): Promise<void> {
  section("COSIGN v1 — freeze AI spending agents across 3 vendors at once (proof, mocks)");
  const { core, members } = await buildMockFleet();

  line();
  line("  Fleet — 3 agents, 3 backends, 3 enforcement modes, 3 venues:");
  for (const m of members) line(`    • ${m.label.padEnd(12)} ${m.id.padEnd(10)} ${m.mode.padEnd(20)} ${m.venue}`);

  section("[1] ONE unified policy, compiled to each backend's NATIVE controls");
  line(`  perTxCap ${usdc(POLICY.perTxCap!)} · dailyCap ${usdc(POLICY.dailyCap!)} · allowlist [${TREASURY}] · approval > ${usdc(POLICY.approvalThreshold!)}`);
  for (const m of members) {
    line();
    line(`  ${m.id} (${m.mode}):`);
    for (const l of describeNative(compile(POLICY, m.mode))) line(`    ${l}`);
  }
  await core.applyPolicy(POLICY);

  section("[2] Agents spend — within policy = allowed, breach = blocked (default-deny)");
  const agents = members.map((m) => new SpendingAgent(m.label, m.provider, m.agentId));
  const spend = (over: Partial<SpendAttempt>): SpendAttempt => ({ amount: "50000000", asset: "USDC", counterparty: TREASURY, venue: "base-sepolia", ...over });
  // payments-bot (coinbase): a normal spend, then one over the per-tx cap.
  await agents[0]!.attempt(spend({ amount: "50000000" })); // allowed
  await agents[0]!.attempt(spend({ amount: "120000000" })); // BLOCKED: > 100 per-tx cap
  // trading-bot (turnkey, pre-sign): a spend above the approval threshold -> human approves it;
  // then a spend to a stranger (off allowlist).
  const pending = await agents[1]!.attempt(spend({ amount: "80000000" })); // 80 > 60 -> needs approval
  if (pending.outcome === "needs_approval") await members[1]!.provider.approve(pending.approvalToken);
  await agents[1]!.attempt(spend({ amount: "10000000", counterparty: STRANGER })); // BLOCKED: allowlist
  // ops-bot (openfort): a normal spend, then one that trips the rolling daily cap.
  await agents[2]!.attempt(spend({ amount: "60000000" })); // allowed (daily 60)
  await agents[2]!.attempt(spend({ amount: "60000000" })); // BLOCKED: 60 + 60 > 100 daily cap

  const spendKinds = new Set(["action_requested", "action_allowed", "action_blocked", "needs_approval", "approval_resolved"]);
  for (const r of await core.ledgerRecords()) {
    if (spendKinds.has(r.payload.kind)) line(`  ${formatEvent(r.payload)}`);
  }

  section("[3] THE KILL SWITCH — one freeze, every backend, concurrently");
  const t0 = Date.now();
  const report = await core.freezeAll("operator hit the big red button");
  const wall = Date.now() - t0;
  for (const p of report.providers) {
    line(`    ${p.providerId.padEnd(10)} ${p.outcome.toUpperCase().padEnd(11)} stopped=${p.stopped} (${ms(p.latencyMs)})`);
  }
  line();
  line(`  >>> all ${report.providers.length} backends stopped: ${report.allStopped ? "YES" : "NO"} in ${ms(report.windowMs)} (wall: ${ms(wall)}) — target < 1000ms`);

  section("[4] The unified, hash-chained ledger — every attempt, everywhere");
  await dumpLedger(core);
}

async function chaos(): Promise<void> {
  section("[5] FAIL-CLOSED under chaos — a backend whose freeze won't confirm");
  // openfort's freeze returns confirmed:false (the stop didn't take); revokeSession is the harder kill.
  const { core } = await buildMockFleet({
    scenarios: { openfort: { freeze: "unconfirmed", revoke: "confirm" } },
    freezeTimeoutMs: 400,
    escalateTimeoutMs: 400,
  });
  await core.applyPolicy(POLICY);
  const report = await core.freezeAll("chaos: openfort can't confirm the stop");
  line();
  line(`  result: allStopped=${report.allStopped} in ${ms(report.windowMs)} — the unconfirmed freeze was escalated to revokeSession`);
  line();
  for (const r of await core.ledgerRecords()) {
    if (r.payload.kind.startsWith("freeze") || r.payload.kind.startsWith("escalation") || r.payload.kind === "still_dangerous") {
      line(`  ${formatEvent(r.payload)}`);
    }
  }
  line();
  line("  The freeze that couldn't confirm was NEVER reported as safe — it was escalated. Default deny.");
}

await headline();
await chaos();
line();
line("  Done. This is the whole thesis: one freeze, every vendor, sub-second, fully audited.");
line();
