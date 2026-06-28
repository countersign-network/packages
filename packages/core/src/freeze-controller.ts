/**
 * The cross-venue freeze controller — the headline capability.
 *
 * ONE action fans out a hard stop to every connected backend CONCURRENTLY and returns a
 * complete, audited verdict in well under a second. This is the one thing no single wallet
 * vendor can do, because each only governs its own rail.
 *
 * Fail-closed contract (prime directive #3):
 *   - Every provider's verdict is kept (we never drop one because another failed).
 *   - A freeze that resolves { confirmed: false }, throws, or times out is treated as
 *     STILL DANGEROUS — never as "probably fine".
 *   - Unconfirmed providers are escalated to the harder kill (revokeSession per agent).
 *     If that also fails, the agent is surfaced as still-dangerous in the ledger + report.
 */

import type {
  AgentRef,
  EnforcementMode,
  EnforcementProvider,
  FreezeScope,
  ProviderCapabilities,
} from "./enforcement-provider";
import type { FreezeMechanism, FreezeOutcome, LedgerEvent, LedgerSink } from "./events";
import type { AgentId, ProviderId } from "./ids";
import { nextId } from "./ids";

export interface ProviderRegistration {
  provider: EnforcementProvider;
  /** Captured once (e.g. at startup) so the freeze hot path never awaits a vendor probe. */
  capabilities: ProviderCapabilities;
  /** Agents known to live on this provider — the escalation targets for revokeSession. */
  agents: AgentRef[];
}

export interface PerProviderFreeze {
  providerId: ProviderId;
  mode: EnforcementMode;
  outcome: FreezeOutcome;
  mechanism?: FreezeMechanism | undefined;
  /** true if the freeze confirmed OR escalation (revokeSession) succeeded. */
  stopped: boolean;
  dangerousAgents: AgentId[];
  latencyMs: number;
}

export interface FreezeReport {
  freezeId: string;
  requestedAt: number;
  windowMs: number;
  allStopped: boolean;
  providers: PerProviderFreeze[];
}

/**
 * Emitted ONLY when a freeze cannot be fully confirmed (some agent/provider is still dangerous after
 * escalation). Production wires this to a pager/Slack — a kill switch nobody is alerted about isn't one.
 */
export interface FreezeAlert {
  freezeId: string;
  /** Providers/agents that could NOT be confirmed stopped — the live dangerous window. */
  dangerous: { providerId: ProviderId; agentId?: AgentId }[];
  windowMs: number;
  reason: string;
  ts: number;
}

export interface FreezeControllerOptions {
  record: LedgerSink["append"];
  /**
   * Called when a freeze resolves STILL DANGEROUS (best-effort; a failing alert never aborts or
   * crashes the freeze). This is the human-escalation hook for production (PagerDuty/Slack/etc.).
   */
  alert?: (alert: FreezeAlert) => void | Promise<void>;
  /** Per-provider freeze timeout. A hung backend must not block the fan-out. Default 800ms. */
  freezeTimeoutMs?: number;
  /** Per-agent escalation (revokeSession) timeout. Default 800ms. */
  escalateTimeoutMs?: number;
  /**
   * Max concurrent vendor calls in the fan-out (provider freezes AND per-agent escalations). Bounds the
   * thundering-herd vendor-API burst at fleet scale — an unbounded Promise.all over hundreds of agents
   * trips vendor rate-limits → timeouts → mass escalation inside the <1s budget. Default 16. For small
   * fleets (>= this many) it's a plain Promise.all, so the <1s SLO is unchanged. (A6.)
   */
  freezeConcurrency?: number;
  /** Injectable clock for deterministic tests. Default Date.now. */
  now?: () => number;
  /** Injectable id mint. Default a monotonic counter for reproducible runs. */
  idFactory?: () => string;
}

type Timed<T> =
  | { ok: true; value: T; ms: number }
  | { ok: false; reason: "timeout" | "error"; error?: unknown; ms: number };

/**
 * Run `fn` over `items` with at most `limit` in flight, preserving result order. Below the limit it's a
 * plain Promise.all (zero overhead for small fleets); above it, a fixed worker pool drains the queue.
 */
async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  if (limit <= 0 || items.length <= limit) return Promise.all(items.map(fn));
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    for (let i = next++; i < items.length; i = next++) {
      results[i] = await fn(items[i]!, i);
    }
  };
  await Promise.all(Array.from({ length: limit }, () => worker()));
  return results;
}

/**
 * Wrap a promise so it ALWAYS resolves (never rejects) within `ms`. This is the fail-closed
 * primitive: a timeout or a rejection both become a non-ok result the caller treats as danger.
 */
function withTimeout<T>(p: Promise<T>, ms: number, now: () => number): Promise<Timed<T>> {
  const start = now();
  return new Promise<Timed<T>>((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve({ ok: false, reason: "timeout", ms: now() - start });
    }, ms);
    p.then(
      (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ ok: true, value, ms: now() - start });
      },
      (error: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ ok: false, reason: "error", error, ms: now() - start });
      },
    );
  });
}

export class FreezeController {
  private readonly freezeTimeoutMs: number;
  private readonly escalateTimeoutMs: number;
  private readonly freezeConcurrency: number;
  private readonly now: () => number;
  private readonly idFactory: () => string;
  private readonly sink: LedgerSink["append"];
  private readonly alertSink: ((alert: FreezeAlert) => void | Promise<void>) | undefined;

  constructor(
    private readonly registrations: ProviderRegistration[],
    opts: FreezeControllerOptions,
  ) {
    this.sink = opts.record;
    this.alertSink = opts.alert;
    this.freezeTimeoutMs = opts.freezeTimeoutMs ?? 800;
    this.escalateTimeoutMs = opts.escalateTimeoutMs ?? 800;
    this.freezeConcurrency = opts.freezeConcurrency ?? 16;
    this.now = opts.now ?? (() => Date.now());
    this.idFactory = opts.idFactory ?? (() => nextId("frz"));
  }

  /** Freeze EVERY agent on EVERY provider. The kill switch. Idempotent. */
  async freezeAll(reason = "manual freeze"): Promise<FreezeReport> {
    // Each provider freezes its whole scope and escalates ALL of its agents.
    const targets = this.registrations.map((reg) => ({ reg, scope: { kind: "provider-all" } as FreezeScope, escalationAgents: reg.agents }));
    return this.runFreeze(targets, reason);
  }

  /**
   * Freeze ONE agent across whatever provider(s) host it — without halting the rest of the fleet (A6).
   * The point of an agent-scoped kill switch is to stop a single rogue agent at low collateral, so an
   * operator isn't forced to choose between "halt everything" and "do nothing". Same fail-closed
   * escalation as freezeAll, scoped to this agent. Returns an empty report if the agent isn't found.
   */
  async freezeAgent(agentId: AgentId, reason = "manual agent freeze"): Promise<FreezeReport> {
    const targets = this.registrations
      .filter((reg) => reg.agents.some((a) => a.agentId === agentId))
      .map((reg) => ({
        reg,
        scope: { kind: "agent", agentId } as FreezeScope,
        escalationAgents: reg.agents.filter((a) => a.agentId === agentId),
      }));
    return this.runFreeze(targets, reason);
  }

  /** Shared fan-out for fleet-wide and agent-scoped freezes. */
  private async runFreeze(
    targets: { reg: ProviderRegistration; scope: FreezeScope; escalationAgents: AgentRef[] }[],
    reason: string,
  ): Promise<FreezeReport> {
    const freezeId = this.idFactory();
    const t0 = this.now();
    await this.record({
      kind: "freeze_requested",
      freezeId,
      targets: targets.map((t) => t.reg.provider.id),
      reason,
      ts: t0,
    });

    // Concurrent fan-out — wall clock is the slowest single provider, not the sum — bounded by
    // freezeConcurrency so a large fleet can't burst past vendor rate-limits (A6).
    const results = await mapLimit(targets, this.freezeConcurrency, (t) => this.freezeOne(t.reg, freezeId, t.scope, t.escalationAgents));

    const dangerous = results.filter((r) => !r.stopped);
    const windowMs = this.now() - t0;

    if (dangerous.length === 0) {
      await this.record({
        kind: "freeze_resolved",
        freezeId,
        providerCount: results.length,
        windowMs,
        ts: this.now(),
      });
    } else {
      await this.record({
        kind: "freeze_partial",
        freezeId,
        confirmed: results.filter((r) => r.stopped).map((r) => r.providerId),
        dangerous: dangerous.map((r) => r.providerId),
        ts: this.now(),
      });
      const dangerousList = dangerous.flatMap((r) =>
        r.dangerousAgents.length > 0
          ? r.dangerousAgents.map((agentId) => ({ providerId: r.providerId, agentId }))
          : [{ providerId: r.providerId }],
      );
      await this.record({ kind: "still_dangerous", freezeId, dangerous: dangerousList, windowMs, ts: this.now() });
      // Page a human — the ledger row alone isn't an alert. Best-effort: never abort the freeze.
      await this.raiseAlert({ freezeId, dangerous: dangerousList, windowMs, reason, ts: this.now() });
    }

    return { freezeId, requestedAt: t0, windowMs, allStopped: dangerous.length === 0, providers: results };
  }

  private async freezeOne(reg: ProviderRegistration, freezeId: string, scope: FreezeScope, escalationAgents: AgentRef[]): Promise<PerProviderFreeze> {
    const mode = reg.capabilities.enforcementMode;
    const res = await withTimeout(reg.provider.freeze(scope), this.freezeTimeoutMs, this.now);

    let outcome: FreezeOutcome;
    let mechanism: FreezeMechanism | undefined;
    let detail: string | undefined;
    if (!res.ok) {
      // Timed out or threw — no confirmation. Fail-closed: treat as still dangerous.
      outcome = "failed";
      detail = res.reason;
    } else if (res.value.confirmed) {
      outcome = "confirmed";
      mechanism = res.value.mechanism;
    } else {
      // Backend acknowledged but could NOT confirm the stop.
      outcome = "unconfirmed";
      mechanism = res.value.mechanism;
    }

    await this.record({
      kind: "freeze_result",
      freezeId,
      providerId: reg.provider.id,
      mode,
      outcome,
      mechanism,
      latencyMs: res.ms,
      detail,
      ts: this.now(),
    });

    if (outcome === "confirmed") {
      return { providerId: reg.provider.id, mode, outcome, mechanism, stopped: true, dangerousAgents: [], latencyMs: res.ms };
    }

    // FAIL-CLOSED ESCALATION: the freeze didn't confirm — try the harder kill per (scoped) agent.
    const dangerousAgents = await this.escalate(reg, freezeId, escalationAgents);
    const stopped = escalationAgents.length > 0 && dangerousAgents.length === 0;
    return { providerId: reg.provider.id, mode, outcome, mechanism, stopped, dangerousAgents, latencyMs: res.ms };
  }

  /** Returns the agents we could NOT confirm stopped. Empty array => escalation succeeded. */
  private async escalate(reg: ProviderRegistration, freezeId: string, agents: AgentRef[]): Promise<AgentId[]> {
    const outcomes = await mapLimit(agents, this.freezeConcurrency, async (a) => {
        const r = await withTimeout(reg.provider.revokeSession(a.agentId), this.escalateTimeoutMs, this.now);
        await this.record({
          kind: "escalation_revoke_session",
          freezeId,
          providerId: reg.provider.id,
          agentId: a.agentId,
          outcome: r.ok ? "confirmed" : "failed",
          latencyMs: r.ms,
          ts: this.now(),
        });
        return { agentId: a.agentId, ok: r.ok };
    });
    return outcomes.filter((o) => !o.ok).map((o) => o.agentId);
  }

  /** Best-effort human alert — a failing/ slow pager must never crash or block the kill switch. */
  private async raiseAlert(alert: FreezeAlert): Promise<void> {
    if (!this.alertSink) return;
    try {
      await this.alertSink(alert);
    } catch (err) {
      console.error("[freeze-controller] alert sink failed:", err);
    }
  }

  /** Best-effort audit write — a logging failure must never crash the kill switch. */
  private async record(event: LedgerEvent): Promise<void> {
    try {
      await this.sink(event);
    } catch (err) {
      // The ledger is the audit artifact; if it's unreachable we still must stop the agents.
      // Surface to stderr so the gap is visible, but do not abort the freeze.
      console.error("[freeze-controller] ledger append failed:", err);
    }
  }
}
