/**
 * MockProvider — a faithful, credential-free stand-in for a real enforcement backend. ONE class
 * parameterized by EnforcementMode, because the mode is exactly the real-world distinction:
 *
 *   native-session-caps : caps live "in the wallet"; freeze = revoke/zero the session.
 *   pre-sign-policy      : evaluate() gates each signature; supports inline human approval.
 *   onchain-policy       : enforcement is on-chain; applyPolicy/freeze are eventually-consistent.
 *
 * It enforces the FULL UnifiedPolicy via the shared evaluator, so "policy compiled" and "policy
 * enforced" are checked against one definition. The MockScenario makes every fail-closed path
 * (unconfirmed freeze, throwing applyPolicy, hung calls, a dangerous agent the freeze can't stop)
 * deterministic. This is what lets the headline demo run and pass a test tonight, with no creds.
 */

import {
  FailClosedError,
  asSessionId,
  nextId,
  type ActionRequest,
  type AgentId,
  type AgentRef,
  type Decision,
  type EnforcementMode,
  type EnforcementProvider,
  type FreezeResult,
  type FreezeScope,
  type HealthStatus,
  type ProviderCapabilities,
  type ProviderEvent,
  type ProviderId,
  type Unsubscribe,
  type Venue,
} from "@cosign/core";
import { evaluatePolicy, type SpendAttempt, type UnifiedPolicy } from "@cosign/policy";
import { DEFAULT_SCENARIO, type MockScenario } from "./scenario";

export type SpendResult =
  | { outcome: "allowed"; action: ActionRequest }
  | { outcome: "blocked"; action: ActionRequest; reason: string }
  | { outcome: "needs_approval"; action: ActionRequest; approvalToken: string; reason: string };

export interface MockProviderOptions {
  id: string;
  mode: EnforcementMode;
  scenario?: MockScenario;
  now?: () => number;
  idFactory?: (prefix: string) => string;
}

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const never = () => new Promise<never>(() => {});

export class MockProvider implements EnforcementProvider {
  readonly id: ProviderId;
  readonly mode: EnforcementMode;
  private readonly scenario: Required<MockScenario>;
  private readonly now: () => number;
  private readonly mint: (prefix: string) => string;

  private readonly agents = new Map<AgentId, AgentRef>();
  private readonly policies = new Map<AgentId, UnifiedPolicy>();
  private readonly policyIds = new Map<AgentId, string>();
  private readonly dailySpent = new Map<AgentId, string>();
  private readonly revoked = new Set<AgentId>();
  private readonly frozenAgents = new Set<AgentId>();
  private providerFrozen = false;
  private readonly approvals = new Map<string, { agentId: AgentId; attempt: SpendAttempt; action: ActionRequest }>();
  private readonly handlers = new Set<(e: ProviderEvent) => void>();

  constructor(opts: MockProviderOptions) {
    this.id = opts.id as ProviderId;
    this.mode = opts.mode;
    this.now = opts.now ?? (() => Date.now());
    this.mint = opts.idFactory ?? ((p) => nextId(p));
    this.scenario = {
      ...DEFAULT_SCENARIO,
      // Onchain backends are eventually-consistent: give applyPolicy/freeze a small default lag.
      applyPolicyDelayMs: opts.mode === "onchain-policy" ? 20 : 0,
      freezeDelayMs: 0,
      revokeDelayMs: 0,
      ...opts.scenario,
    };
  }

  async capabilities(): Promise<ProviderCapabilities> {
    return {
      enforcementMode: this.mode,
      supportsInlineApproval: this.mode === "pre-sign-policy",
      supportsOnchainGuard: this.mode === "onchain-policy",
      supportsSessionRevocation: true,
      realtimeEvents: this.mode !== "native-session-caps", // Coinbase is webhook/poll (see sdk-research)
      venues: ["base-sepolia", "ethereum-sepolia", "polygon-amoy"],
    };
  }

  async provisionWallet(agentId: AgentId, opts: { venue: Venue }): Promise<AgentRef> {
    const ref: AgentRef = {
      provider: this.id,
      agentId,
      wallet: `0xMOCK_${this.id}_${agentId}`,
      venue: opts.venue,
      sessionId: asSessionId(this.mint("sess")),
    };
    this.agents.set(agentId, ref);
    this.dailySpent.set(agentId, "0");
    return ref;
  }

  async applyPolicy(agentId: AgentId, policy: UnifiedPolicy): Promise<{ policyId: string }> {
    if (this.scenario.applyPolicy === "timeout") {
      await delay(this.scenario.applyPolicyDelayMs || 30);
      throw new FailClosedError(`${this.id}: applyPolicy timed out — cannot confirm policy is live`, this.id);
    }
    if (this.scenario.applyPolicy === "unconfirmed") {
      throw new FailClosedError(`${this.id}: cannot confirm new policy is live`, this.id);
    }
    if (this.scenario.applyPolicyDelayMs) await delay(this.scenario.applyPolicyDelayMs);

    this.policies.set(agentId, policy);
    const policyId = this.mint("pol");
    this.policyIds.set(agentId, policyId);
    this.emit({ type: "policy_applied", agentId, policyId, ts: this.now() });
    return { policyId };
  }

  /** Interface evaluate() — pre-sign gate. Pure decision, no state change. */
  async evaluate(action: ActionRequest): Promise<Decision> {
    const policyId = this.policyIds.get(action.agentId) ?? "none";
    const r = this.decide(action.agentId, this.toAttempt(action));
    if (r.outcome === "allow") return { outcome: "allow", policyId };
    if (r.outcome === "deny") return { outcome: "deny", policyId, reason: r.reason };
    const approvalToken = this.mint("appr");
    this.approvals.set(approvalToken, { agentId: action.agentId, attempt: this.toAttempt(action), action });
    return { outcome: "needs_approval", policyId, approvalToken, reason: r.reason };
  }

  async approve(approvalToken: string): Promise<void> {
    const pending = this.approvals.get(approvalToken);
    if (!pending) throw new Error(`unknown approval token ${approvalToken}`);
    this.approvals.delete(approvalToken);
    this.commitSpend(pending.agentId, pending.attempt);
    this.emit({ type: "approval_resolved", agentId: pending.agentId, approvalToken, decision: "approved", ts: this.now() });
    this.emit({
      type: "action_allowed",
      agentId: pending.agentId,
      action: pending.action,
      policyId: this.policyIds.get(pending.agentId) ?? "none",
      ts: this.now(),
    });
  }

  async deny(approvalToken: string, reason = "denied by approver"): Promise<void> {
    const pending = this.approvals.get(approvalToken);
    if (!pending) throw new Error(`unknown approval token ${approvalToken}`);
    this.approvals.delete(approvalToken);
    this.emit({ type: "approval_resolved", agentId: pending.agentId, approvalToken, decision: "denied", ts: this.now() });
    this.emit({
      type: "action_blocked",
      agentId: pending.agentId,
      action: pending.action,
      policyId: this.policyIds.get(pending.agentId) ?? "none",
      reason,
      ts: this.now(),
    });
  }

  /**
   * Mock-only driver: simulate the agent attempting a spend and the backend enforcing. Emits the
   * action_requested -> action_allowed/blocked events the ledger records, and respects freeze/revoke.
   */
  async attemptSpend(agentId: AgentId, attempt: SpendAttempt): Promise<SpendResult> {
    const action = this.toAction(agentId, attempt);
    const policyId = this.policyIds.get(agentId) ?? "none";
    this.emit({ type: "action_requested", agentId, action, ts: this.now() });

    if (this.revoked.has(agentId)) return this.block(agentId, action, policyId, "session revoked");
    if (this.providerFrozen || this.frozenAgents.has(agentId)) return this.block(agentId, action, policyId, "frozen");
    if (!this.policies.has(agentId)) return this.block(agentId, action, policyId, "no policy (default deny)");

    const r = this.decide(agentId, attempt);
    if (r.outcome === "deny") return this.block(agentId, action, policyId, r.reason);
    if (r.outcome === "needs_approval") {
      const approvalToken = this.mint("appr");
      this.approvals.set(approvalToken, { agentId, attempt, action });
      this.emit({ type: "needs_approval", agentId, action, approvalToken, reason: r.reason, ts: this.now() });
      return { outcome: "needs_approval", action, approvalToken, reason: r.reason };
    }
    this.commitSpend(agentId, attempt);
    this.emit({ type: "action_allowed", agentId, action, policyId, ts: this.now() });
    return { outcome: "allowed", action };
  }

  async freeze(scope: FreezeScope): Promise<FreezeResult> {
    if (this.scenario.freeze === "timeout") return never();
    if (this.scenario.freezeDelayMs) await delay(this.scenario.freezeDelayMs);

    const confirmed = this.scenario.freeze === "confirm";
    const affected = this.scopeAgents(scope);
    if (confirmed) {
      if (scope.kind === "provider-all") this.providerFrozen = true;
      else this.frozenAgents.add(scope.agentId);
    }
    const mechanism: FreezeResult["mechanism"] =
      this.mode === "native-session-caps" ? "caps-zeroed" : this.mode === "onchain-policy" ? "onchain-guard" : "policy-deny";
    this.emit({ type: "frozen", scope, mechanism, ts: this.now() });
    return { confirmed, frozenAgents: affected, mechanism, at: this.now() };
  }

  async unfreeze(scope: FreezeScope): Promise<void> {
    if (scope.kind === "provider-all") {
      this.providerFrozen = false;
      this.frozenAgents.clear();
    } else {
      this.frozenAgents.delete(scope.agentId);
    }
    this.emit({ type: "unfrozen", scope, ts: this.now() });
  }

  async revokeSession(agentId: AgentId): Promise<void> {
    if (this.scenario.revoke === "hang") return never();
    if (this.scenario.revokeDelayMs) await delay(this.scenario.revokeDelayMs);
    if (this.scenario.revoke === "fail") throw new Error(`${this.id}: revokeSession failed`);
    this.revoked.add(agentId);
    const ref = this.agents.get(agentId);
    this.emit({
      type: "session_revoked",
      agentId,
      ts: this.now(),
      ...(ref?.sessionId !== undefined ? { sessionId: ref.sessionId } : {}),
    });
  }

  subscribe(handler: (event: ProviderEvent) => void): Unsubscribe {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  async health(): Promise<HealthStatus> {
    if (this.scenario.health === "down") return { healthy: false, detail: "backend down" };
    if (this.scenario.health === "degraded") return { healthy: true, latencyMs: 250, detail: "degraded" };
    return { healthy: true, latencyMs: 12 };
  }

  /* ---- internals ---- */

  private decide(agentId: AgentId, attempt: SpendAttempt) {
    const policy = this.policies.get(agentId);
    if (!policy) return { outcome: "deny", reason: "no policy (default deny)" } as const;
    return evaluatePolicy(policy, attempt, { dailySpent: this.dailySpent.get(agentId) });
  }

  private commitSpend(agentId: AgentId, attempt: SpendAttempt): void {
    const policy = this.policies.get(agentId);
    if (policy && attempt.asset === policy.asset) {
      const prior = this.dailySpent.get(agentId) ?? "0";
      this.dailySpent.set(agentId, (BigInt(prior) + BigInt(attempt.amount)).toString());
    }
  }

  private block(agentId: AgentId, action: ActionRequest, policyId: string, reason: string): SpendResult {
    this.emit({ type: "action_blocked", agentId, action, policyId, reason, ts: this.now() });
    return { outcome: "blocked", action, reason };
  }

  private toAttempt(action: ActionRequest): SpendAttempt {
    return { amount: action.amount, asset: action.asset, counterparty: action.counterparty, venue: action.venue };
  }

  private toAction(agentId: AgentId, attempt: SpendAttempt): ActionRequest {
    return {
      id: this.mint("act"),
      agentId,
      kind: "transfer",
      asset: attempt.asset,
      amount: attempt.amount,
      venue: attempt.venue,
      ts: this.now(),
      ...(attempt.counterparty !== undefined ? { counterparty: attempt.counterparty } : {}),
    };
  }

  private scopeAgents(scope: FreezeScope): AgentId[] {
    return scope.kind === "provider-all" ? [...this.agents.keys()] : [scope.agentId];
  }

  private emit(event: ProviderEvent): void {
    for (const h of this.handlers) h(event);
  }
}
