/**
 * CosignCore — the brain. Backend-agnostic by construction: it knows only the EnforcementProvider
 * interface, the policy compiler, the hash-chained ledger, and the freeze controller. No vendor
 * logic leaks in here (prime directive #4). Every provider event and every freeze action lands in
 * the one ledger, and is broadcast to subscribers (the websocket layer).
 */

import {
  FreezeController,
  providerEventToLedger,
  type AgentId,
  type AgentRef,
  type EnforcementProvider,
  type FreezeReport,
  type LedgerEvent,
  type ProviderRegistration,
  type Venue,
} from "@cosign/core";
import { InMemoryLedger, type LedgerPort, type LedgerRecord } from "@cosign/ledger";
import type { UnifiedPolicy } from "@cosign/policy";
import type { ApplyPolicyResult, ProviderHealth } from "@cosign/api-contract";

export interface CosignCoreOptions {
  ledger?: LedgerPort<LedgerEvent>;
  freezeTimeoutMs?: number;
  escalateTimeoutMs?: number;
  now?: () => number;
}

type LedgerSubscriber = (record: LedgerRecord<LedgerEvent>) => void;

export class CosignCore {
  private readonly ledger: LedgerPort<LedgerEvent>;
  private readonly registrations: ProviderRegistration[] = [];
  private readonly controller: FreezeController;
  private readonly subscribers = new Set<LedgerSubscriber>();
  private readonly unsubs: (() => void)[] = [];

  constructor(opts: CosignCoreOptions = {}) {
    this.ledger = opts.ledger ?? new InMemoryLedger<LedgerEvent>();
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

  /**
   * Compile + apply ONE unified policy across every backend (or a single agent). Fail-closed: a
   * backend that throws (couldn't confirm the policy is live) is reported as `failed` and an error
   * is recorded — we never assume the looser/old policy is fine.
   */
  async applyPolicy(policy: UnifiedPolicy, agentId?: AgentId): Promise<ApplyPolicyResult> {
    const result: ApplyPolicyResult = { applied: [], failed: [] };
    await Promise.all(
      this.registrations.flatMap((reg) => {
        const targets = agentId ? reg.agents.filter((a) => a.agentId === agentId) : reg.agents;
        return targets.map(async (agent) => {
          try {
            const { policyId } = await reg.provider.applyPolicy(agent.agentId, policy);
            result.applied.push({ providerId: reg.provider.id, agentId: agent.agentId, policyId });
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
    return this.controller.freezeAll(reason);
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
