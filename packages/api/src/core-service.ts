/**
 * CountersignCore — the brain. Backend-agnostic by construction: it knows only the EnforcementProvider
 * interface, the policy compiler, the hash-chained ledger, and the freeze controller. No vendor
 * logic leaks in here (prime directive #4). Every provider event and every freeze action lands in
 * the one ledger, and is broadcast to subscribers (the websocket layer).
 */

import {
  FreezeController,
  nextId,
  providerEventToLedger,
  type ActionRequest,
  type AgentId,
  type AgentRef,
  type EnforcementProvider,
  type FreezeReport,
  type LedgerEvent,
  type ProviderId,
  type ProviderRegistration,
  type Venue,
} from "@countersign/core";
import { InMemoryLedger, anchorHead, type AnchorPoint, type LedgerAnchor, type LedgerPort, type LedgerRecord } from "@countersign/ledger";
import { evaluatePolicy, type SpendAttempt, type UnifiedPolicy } from "@countersign/policy";
import type {
  ApplyPolicyResult,
  ApprovalResolution,
  ApprovalsResponse,
  EvaluateResponse,
  PendingApprovalDTO,
  ProviderHealth,
} from "@countersign/api-contract";

export interface CountersignCoreOptions {
  ledger?: LedgerPort<LedgerEvent>;
  /** External anchor for the ledger head (published after each freeze). See ledger/anchor.ts. */
  anchor?: LedgerAnchor;
  freezeTimeoutMs?: number;
  escalateTimeoutMs?: number;
  now?: () => number;
}

type LedgerSubscriber = (record: LedgerRecord<LedgerEvent>) => void;

export class CountersignCore {
  private readonly ledger: LedgerPort<LedgerEvent>;
  private readonly registrations: ProviderRegistration[] = [];
  private readonly controller: FreezeController;
  private readonly subscribers = new Set<LedgerSubscriber>();
  private readonly unsubs: (() => void)[] = [];
  // Countersign's own view of policy + spend, for the pre-flight guard (the layer above the wallets).
  private readonly policies = new Map<AgentId, UnifiedPolicy>();
  private readonly policyIds = new Map<AgentId, string>();
  private readonly dailySpent = new Map<AgentId, string>();
  // Spends held pending human approval (the consensus path), keyed by approval token.
  private readonly pending = new Map<string, { agentId: AgentId; providerId: ProviderId; action: ActionRequest; attempt: SpendAttempt; policyId: string; reason: string }>();
  // Frozen posture — fail-closed: while frozen, pending approvals cannot be approved through.
  private frozen = false;
  private readonly anchor?: LedgerAnchor;

  constructor(opts: CountersignCoreOptions = {}) {
    this.ledger = opts.ledger ?? new InMemoryLedger<LedgerEvent>();
    if (opts.anchor) this.anchor = opts.anchor;
    this.controller = new FreezeController(this.registrations, {
      record: (e) => this.append(e),
      ...(opts.freezeTimeoutMs !== undefined ? { freezeTimeoutMs: opts.freezeTimeoutMs } : {}),
      ...(opts.escalateTimeoutMs !== undefined ? { escalateTimeoutMs: opts.escalateTimeoutMs } : {}),
      ...(opts.now !== undefined ? { now: opts.now } : {}),
    });
  }

  /** Register a backend. Its events stream straight into the unified ledger. */
  async registerProvider(provider: EnforcementProvider): Promise<void> {
    const capabilities = await provider.capabilities();
    const reg: ProviderRegistration = { provider, capabilities, agents: [] };
    this.registrations.push(reg);
    const unsub = provider.subscribe((ev) => {
      const mapped = providerEventToLedger(provider.id, ev);
      if (mapped) void this.append(mapped);
    });
    this.unsubs.push(unsub);
  }

  async provisionAgent(providerId: string, agentId: AgentId, venue: Venue): Promise<AgentRef> {
    const reg = this.regFor(providerId);
    const ref = await reg.provider.provisionWallet(agentId, { venue });
    reg.agents.push(ref);
    return ref;
  }

  agents(): AgentRef[] {
    return this.registrations.flatMap((r) => r.agents);
  }

  modeOf(providerId: string): string {
    return this.regFor(providerId).capabilities.enforcementMode;
  }

  /** True if a backend with this id is already registered (lets callers register lazily). */
  hasProvider(providerId: string): boolean {
    return this.registrations.some((r) => r.provider.id === providerId);
  }

  /**
   * Compile + apply ONE unified policy across every backend (or a single agent). Fail-closed: a
   * backend that throws (couldn't confirm the policy is live) is reported as `failed` and an error
   * is recorded — we never assume the looser/old policy is fine.
   */
  async applyPolicy(policy: UnifiedPolicy, agentId?: AgentId): Promise<ApplyPolicyResult> {
    const result: ApplyPolicyResult = { applied: [], failed: [] };
    const corePolicyId = nextId("pol");
    await Promise.all(
      this.registrations.flatMap((reg) => {
        const targets = agentId ? reg.agents.filter((a) => a.agentId === agentId) : reg.agents;
        return targets.map(async (agent) => {
          try {
            const { policyId } = await reg.provider.applyPolicy(agent.agentId, policy);
            result.applied.push({ providerId: reg.provider.id, agentId: agent.agentId, policyId });
            // Countersign retains the unified policy for its own pre-flight guard (enforces what the
            // backend can't, and is the canonical decision the agent asks for before spending).
            this.policies.set(agent.agentId, policy);
            this.policyIds.set(agent.agentId, corePolicyId);
            if (!this.dailySpent.has(agent.agentId)) this.dailySpent.set(agent.agentId, "0");
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            result.failed.push({ providerId: reg.provider.id, agentId: agent.agentId, error: message });
            await this.append({ kind: "error", providerId: reg.provider.id, agentId: agent.agentId, message, ts: this.nowTs() });
          }
        });
      }),
    );
    return result;
  }

  /**
   * The kill switch. Each freeze_* event is streamed to subscribers as it's recorded; the server
   * layer additionally delivers the aggregate report (so a phone sees the verdict immediately).
   */
  async freezeAll(reason = "manual freeze"): Promise<FreezeReport> {
    const report = await this.controller.freezeAll(reason);
    this.frozen = true; // fail-closed posture: blocks approving pending spends through
    // Anchor the ledger head at the freeze moment (best-effort; the critical point to externalise).
    if (this.anchor) await anchorHead(this.ledger, this.anchor).catch(() => undefined);
    return report;
  }

  /** Publish the current ledger head to the external anchor (no-op if no anchor configured). */
  async anchorNow(): Promise<AnchorPoint | undefined> {
    return this.anchor ? anchorHead(this.ledger, this.anchor) : undefined;
  }

  /** Lift a freeze across every backend (demo/replay; real product needs it too). */
  async unfreezeAll(): Promise<void> {
    await Promise.all(
      this.registrations.map((r) => Promise.resolve(r.provider.unfreeze({ kind: "provider-all" })).catch(() => {})),
    );
    this.frozen = false;
  }

  /**
   * The agent-facing pre-flight guard. An agent calls this BEFORE touching its wallet; Countersign
   * answers from the unified policy it holds, records the decision in the ledger, and (on allow)
   * advances its own daily tally. This is the call made on every transaction — fail-closed: no
   * policy => deny.
   */
  async evaluateSpend(agentId: AgentId, attempt: SpendAttempt): Promise<EvaluateResponse> {
    const located = this.agents().find((a) => a.agentId === agentId);
    const providerId: ProviderId = located?.provider ?? (`unknown` as ProviderId);
    const policyId = this.policyIds.get(agentId) ?? "none";
    const action: ActionRequest = {
      id: nextId("act"),
      agentId,
      kind: attempt.asset === "USDC" ? "x402-payment" : "transfer",
      asset: attempt.asset,
      amount: attempt.amount,
      venue: attempt.venue,
      ts: Date.now(),
      ...(attempt.counterparty !== undefined ? { counterparty: attempt.counterparty } : {}),
    };
    await this.append({ kind: "action_requested", providerId, agentId, action, ts: action.ts });

    const policy = this.policies.get(agentId);
    if (!policy) {
      const reason = "no policy applied (default deny)";
      await this.append({ kind: "action_blocked", providerId, agentId, action, policyId, reason, ts: Date.now() });
      return { outcome: "deny", reason, policyId };
    }

    const res = evaluatePolicy(policy, attempt, { dailySpent: this.dailySpent.get(agentId) });
    if (res.outcome === "allow") {
      if (attempt.asset === policy.asset) {
        const prior = this.dailySpent.get(agentId) ?? "0";
        this.dailySpent.set(agentId, (BigInt(prior) + BigInt(attempt.amount)).toString());
      }
      await this.append({ kind: "action_allowed", providerId, agentId, action, policyId, ts: Date.now() });
      return { outcome: "allow", policyId };
    }
    if (res.outcome === "deny") {
      await this.append({ kind: "action_blocked", providerId, agentId, action, policyId, reason: res.reason, ts: Date.now() });
      return { outcome: "deny", reason: res.reason, policyId };
    }
    const approvalToken = nextId("appr");
    this.pending.set(approvalToken, { agentId, providerId, action, attempt, policyId, reason: res.reason });
    await this.append({ kind: "needs_approval", providerId, agentId, action, approvalToken, reason: res.reason, ts: Date.now() });
    return { outcome: "needs_approval", reason: res.reason, approvalToken, policyId };
  }

  /** Spends currently held pending human approval. */
  approvals(): ApprovalsResponse {
    return {
      approvals: [...this.pending.entries()].map(([approvalToken, p]): PendingApprovalDTO => ({
        approvalToken,
        agentId: p.agentId,
        providerId: p.providerId,
        amount: p.action.amount,
        asset: p.action.asset,
        venue: p.action.venue,
        reason: p.reason,
        ts: p.action.ts,
        ...(p.action.counterparty !== undefined ? { counterparty: p.action.counterparty } : {}),
      })),
    };
  }

  /**
   * Approve a pending spend. Fail-closed: if the system is frozen, approval is REJECTED (a freeze
   * overrides any in-flight approval — you can't approve money out the door mid-kill-switch).
   */
  async approve(approvalToken: string): Promise<ApprovalResolution> {
    const p = this.pending.get(approvalToken);
    if (!p) throw new Error(`unknown approval token: ${approvalToken}`);
    this.pending.delete(approvalToken);

    if (this.frozen) {
      await this.append({ kind: "approval_resolved", providerId: p.providerId, agentId: p.agentId, approvalToken, decision: "denied", ts: Date.now() });
      await this.append({ kind: "action_blocked", providerId: p.providerId, agentId: p.agentId, action: p.action, policyId: p.policyId, reason: "frozen — approval rejected", ts: Date.now() });
      return { outcome: "denied", agentId: p.agentId, approvalToken, reason: "frozen — approval rejected" };
    }

    const policy = this.policies.get(p.agentId);
    if (policy && p.attempt.asset === policy.asset) {
      const prior = this.dailySpent.get(p.agentId) ?? "0";
      this.dailySpent.set(p.agentId, (BigInt(prior) + BigInt(p.attempt.amount)).toString());
    }
    await this.append({ kind: "approval_resolved", providerId: p.providerId, agentId: p.agentId, approvalToken, decision: "approved", ts: Date.now() });
    await this.append({ kind: "action_allowed", providerId: p.providerId, agentId: p.agentId, action: p.action, policyId: p.policyId, ts: Date.now() });
    return { outcome: "approved", agentId: p.agentId, approvalToken };
  }

  async deny(approvalToken: string, reason = "denied by approver"): Promise<ApprovalResolution> {
    const p = this.pending.get(approvalToken);
    if (!p) throw new Error(`unknown approval token: ${approvalToken}`);
    this.pending.delete(approvalToken);
    await this.append({ kind: "approval_resolved", providerId: p.providerId, agentId: p.agentId, approvalToken, decision: "denied", ts: Date.now() });
    await this.append({ kind: "action_blocked", providerId: p.providerId, agentId: p.agentId, action: p.action, policyId: p.policyId, reason, ts: Date.now() });
    return { outcome: "denied", agentId: p.agentId, approvalToken, reason };
  }

  async health(): Promise<ProviderHealth[]> {
    return Promise.all(
      this.registrations.map(async (reg) => {
        const h = await reg.provider.health();
        return {
          id: reg.provider.id,
          mode: reg.capabilities.enforcementMode,
          healthy: h.healthy,
          ...(h.detail !== undefined ? { detail: h.detail } : {}),
        };
      }),
    );
  }

  async ledgerRecords(): Promise<LedgerRecord<LedgerEvent>[]> {
    return this.ledger.all();
  }

  async verifyLedger(): Promise<boolean> {
    return (await this.ledger.verify()).ok;
  }

  /** The ledger signer's public key (base64), if signed — for independent third-party verification. */
  ledgerPublicKey(): string | undefined {
    return this.ledger.publicKey;
  }

  /** Append a controller/monitor-origin event to the ledger (e.g. anomaly detections). */
  async recordEvent(event: LedgerEvent): Promise<void> {
    await this.append(event);
  }

  /** Subscribe to ledger appends (the websocket layer uses this to push to clients). */
  onLedgerAppend(cb: LedgerSubscriber): () => void {
    this.subscribers.add(cb);
    return () => this.subscribers.delete(cb);
  }

  /** Tear down provider subscriptions. */
  close(): void {
    for (const u of this.unsubs) u();
    this.unsubs.length = 0;
  }

  private async append(event: LedgerEvent): Promise<void> {
    const record = await this.ledger.append(event);
    for (const sub of this.subscribers) sub(record);
  }

  private regFor(providerId: string): ProviderRegistration {
    const reg = this.registrations.find((r) => r.provider.id === providerId);
    if (!reg) throw new Error(`unknown provider: ${providerId}`);
    return reg;
  }

  private nowTs(): number {
    return Date.now();
  }
}
