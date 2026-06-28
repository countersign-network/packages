/**
 * CardRailProvider (A7) — the shared base for `realtime-auth-gate` card adapters (Lithic, Stripe,
 * Airwallex). The three card adapters are ~400 lines of near-identical scaffolding: provision a virtual
 * card, map a UnifiedPolicy to the card's native spend limits, pause/close to freeze, and — the security
 * core — answer each pending authorization with a synchronous approve/decline inside the network window.
 *
 * This base captures the common EnforcementProvider shape (event plumbing, the freeze/unfreeze/revoke
 * verbs, capabilities) and the `evaluateAuthorization` gate, delegating the VENDOR specifics to abstract
 * hooks the subclass fills in (the SDK calls + the webhook signature verification stay vendor-side). It
 * is deliberately dependency-free (no policy/SDK imports) so it lives in core: the subclass supplies the
 * actual policy decision via `authorize()`.
 */

import type {
  AgentRef,
  AuthorizationDecision,
  AuthorizationRequest,
  EnforcementProvider,
  FreezeResult,
  FreezeScope,
  HealthStatus,
  ProviderCapabilities,
  ProviderEvent,
  Unsubscribe,
} from "./enforcement-provider";
import type { UnifiedPolicy } from "./policy";
import type { AgentId, ProviderId, Venue } from "./ids";

export abstract class CardRailProvider implements EnforcementProvider {
  abstract readonly id: ProviderId;

  private readonly listeners = new Set<(event: ProviderEvent) => void>();

  /* ---- vendor hooks the concrete adapter implements ---- */
  protected abstract venues(): Venue[];
  protected abstract provisionCard(agentId: AgentId, opts: { venue: Venue }): Promise<AgentRef>;
  /** Map the unified policy to the card's native spend controls. Return any fields NOT bound natively. */
  protected abstract applyCardLimits(agentId: AgentId, policy: UnifiedPolicy): Promise<{ policyId: string; countersignTracked?: string[] }>;
  protected abstract pauseCard(scope: FreezeScope): Promise<FreezeResult>;
  protected abstract resumeCard(scope: FreezeScope): Promise<void>;
  protected abstract closeCard(agentId: AgentId): Promise<void>;
  protected abstract cardHealth(): Promise<HealthStatus>;
  /** The policy decision for a normalized authorization — the subclass evaluates against its retained policy. */
  protected abstract authorize(req: AuthorizationRequest): Promise<AuthorizationDecision>;

  /* ---- the shared EnforcementProvider surface ---- */
  async capabilities(): Promise<ProviderCapabilities> {
    return {
      enforcementMode: "realtime-auth-gate",
      supportsInlineApproval: true, // the real-time auth decision IS an inline approve/decline
      supportsOnchainGuard: false,
      supportsSessionRevocation: true, // close the card
      realtimeEvents: true, // the authorization stream
      supportsRealtimeAuth: true,
      venues: this.venues(),
    };
  }

  provisionWallet(agentId: AgentId, opts: { venue: Venue }): Promise<AgentRef> {
    return this.provisionCard(agentId, opts);
  }

  async applyPolicy(agentId: AgentId, policy: UnifiedPolicy): Promise<{ policyId: string }> {
    const { policyId, countersignTracked } = await this.applyCardLimits(agentId, policy);
    this.emit({ type: "policy_applied", agentId, policyId, ts: this.now() });
    if (countersignTracked && countersignTracked.length > 0) {
      this.emit({ type: "error", agentId, message: `countersign-tracked (not native): ${countersignTracked.join(", ")}`, ts: this.now() });
    }
    return { policyId };
  }

  freeze(scope: FreezeScope): Promise<FreezeResult> {
    return this.pauseCard(scope);
  }

  unfreeze(scope: FreezeScope): Promise<void> {
    return this.resumeCard(scope);
  }

  revokeSession(agentId: AgentId): Promise<void> {
    return this.closeCard(agentId);
  }

  health(): Promise<HealthStatus> {
    return this.cardHealth();
  }

  subscribe(handler: (event: ProviderEvent) => void): Unsubscribe {
    this.listeners.add(handler);
    return () => this.listeners.delete(handler);
  }

  /**
   * The real-time authorization gate (A7). Runs the subclass's policy decision, AUDITS it
   * (action_allowed / action_blocked), and is FAIL-CLOSED: any thrown error declines the charge. This is
   * the method the adapter's verified webhook handler calls after mapping its vendor payload.
   */
  async evaluateAuthorization(req: AuthorizationRequest): Promise<AuthorizationDecision> {
    const action = {
      id: `auth_${req.authId ?? req.ts}`,
      agentId: req.agentId,
      kind: "transfer" as const,
      asset: req.asset,
      amount: req.amount,
      venue: req.venue ?? (this.venues()[0] ?? ("card" as Venue)),
      ...(req.counterparty !== undefined ? { counterparty: req.counterparty } : {}),
      ts: req.ts,
    };
    try {
      const decision = await this.authorize(req);
      if (decision.approved) {
        this.emit({ type: "action_allowed", agentId: req.agentId, action, policyId: "realtime-auth", ts: this.now() });
      } else {
        this.emit({ type: "action_blocked", agentId: req.agentId, action, policyId: "realtime-auth", reason: decision.reason ?? "declined", ts: this.now() });
      }
      return decision;
    } catch (err) {
      const reason = `authorization decision failed — declined (default deny): ${err instanceof Error ? err.message : String(err)}`;
      this.emit({ type: "action_blocked", agentId: req.agentId, action, policyId: "realtime-auth", reason, ts: this.now() });
      return { approved: false, reason };
    }
  }

  /* ---- helpers for subclasses ---- */
  protected emit(event: ProviderEvent): void {
    for (const l of this.listeners) l(event);
  }

  protected now(): number {
    return Date.now();
  }
}
