/**
 * Anomaly-freeze v0 — heuristic circuit breakers (roadmap moat #2, handoff Phase 3). Watches the
 * unified spend stream and, when a pattern trips, either alerts or AUTO-FIRES the freeze. Heuristics
 * only (no ML): spend velocity, a burst of blocked attempts (an agent probing its limits), a
 * first-seen counterparty, and cumulative spend in a window.
 *
 * This is the cross-rail brain in embryo: it sees an agent's ENTIRE spend across every backend, so
 * it catches patterns no single-rail vendor can. Time comes from each event's own `ts`, so it's
 * fully deterministic and testable.
 */

import type { AgentId, LedgerEvent } from "@cosign/core";
import { toBig } from "@cosign/core";
import type { CosignCore } from "./core-service";

export type AnomalyAction = "alert" | "freeze";

export interface AnomalyConfig {
  /** Too many allowed spends in a window. */
  velocity?: { maxSpends: number; windowMs: number; action?: AnomalyAction };
  /** A burst of BLOCKED attempts — an agent hammering its limits. */
  blockedBurst?: { maxBlocked: number; windowMs: number; action?: AnomalyAction };
  /** Paying a counterparty never seen before for this agent. */
  newCounterparty?: { action?: AnomalyAction };
  /** Cumulative allowed spend (of `asset`) in a window exceeds a soft ceiling. */
  cumulative?: { asset: string; maxAmount: string; windowMs: number; action?: AnomalyAction };
}

interface AgentState {
  allowedTs: number[];
  blockedTs: number[];
  spend: { ts: number; amount: string }[];
  seenCounterparties: Set<string>;
}

const prune = (xs: number[], cutoff: number) => xs.filter((t) => t >= cutoff);

export class AnomalyMonitor {
  private readonly state = new Map<AgentId, AgentState>();
  private readonly unsub: () => void;
  /** Disarmed after firing a freeze, so it doesn't spam. Re-arm to resume auto-freezing. */
  private armed = true;

  constructor(
    private readonly core: CosignCore,
    private readonly config: AnomalyConfig,
  ) {
    this.unsub = core.onLedgerAppend((record) => {
      void this.observe(record.payload);
    });
  }

  rearm(): void {
    this.armed = true;
  }

  stop(): void {
    this.unsub();
  }

  private agent(id: AgentId): AgentState {
    let s = this.state.get(id);
    if (!s) {
      s = { allowedTs: [], blockedTs: [], spend: [], seenCounterparties: new Set() };
      this.state.set(id, s);
    }
    return s;
  }

  async observe(e: LedgerEvent): Promise<void> {
    if (e.kind === "action_allowed") {
      const s = this.agent(e.agentId);
      s.allowedTs.push(e.ts);
      s.spend.push({ ts: e.ts, amount: e.action.amount });

      if (this.config.velocity) {
        const { maxSpends, windowMs } = this.config.velocity;
        s.allowedTs = prune(s.allowedTs, e.ts - windowMs);
        if (s.allowedTs.length > maxSpends) {
          await this.trip(e.agentId, "velocity", `${s.allowedTs.length} spends in ${windowMs}ms (max ${maxSpends})`, this.config.velocity.action);
        }
      }

      if (this.config.cumulative && e.action.asset === this.config.cumulative.asset) {
        const { maxAmount, windowMs } = this.config.cumulative;
        s.spend = s.spend.filter((x) => x.ts >= e.ts - windowMs);
        const total = s.spend.reduce((acc, x) => acc + toBig(x.amount), 0n);
        if (total > toBig(maxAmount)) {
          await this.trip(e.agentId, "cumulative", `${total} spent in ${windowMs}ms (max ${maxAmount})`, this.config.cumulative.action);
        }
      }

      if (this.config.newCounterparty && e.action.counterparty && !s.seenCounterparties.has(e.action.counterparty)) {
        s.seenCounterparties.add(e.action.counterparty);
        // Only flag after the first counterparty is established (don't flag the very first spend).
        if (s.seenCounterparties.size > 1) {
          await this.trip(e.agentId, "new_counterparty", `first payment to ${e.action.counterparty}`, this.config.newCounterparty.action);
        }
      } else if (e.action.counterparty) {
        s.seenCounterparties.add(e.action.counterparty);
      }
    } else if (e.kind === "action_blocked" && this.config.blockedBurst) {
      const s = this.agent(e.agentId);
      s.blockedTs.push(e.ts);
      const { maxBlocked, windowMs } = this.config.blockedBurst;
      s.blockedTs = prune(s.blockedTs, e.ts - windowMs);
      if (s.blockedTs.length > maxBlocked) {
        await this.trip(e.agentId, "blocked_burst", `${s.blockedTs.length} blocked attempts in ${windowMs}ms (max ${maxBlocked})`, this.config.blockedBurst.action);
      }
    }
  }

  private async trip(
    agentId: AgentId,
    rule: "velocity" | "blocked_burst" | "new_counterparty" | "cumulative",
    detail: string,
    action: AnomalyAction = "alert",
  ): Promise<void> {
    const providerId = this.core.agents().find((a) => a.agentId === agentId)?.provider;
    await this.core.recordEvent({
      kind: "anomaly_detected",
      agentId,
      ...(providerId !== undefined ? { providerId } : {}),
      rule,
      detail,
      action,
      ts: Date.now(),
    });
    if (action === "freeze" && this.armed) {
      this.armed = false; // avoid re-freezing on every subsequent event
      await this.core.freezeAll(`anomaly: ${rule} — ${detail}`);
    }
  }
}
