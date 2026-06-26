/**
 * Lithic adapter — a NON-CRYPTO rail. Proves Countersign's thesis is rail-agnostic: the same policy +
 * freeze + ledger that governs crypto wallets governs a virtual Visa card. EnforcementMode =
 * native-session-caps (the card's spend_limit is enforced by Lithic/Visa, exactly like Coinbase's
 * MPC caps — the agent simply cannot exceed it).
 *
 * Mapping (verified against lithic@0.123.0):
 *  - provisionWallet -> cards.create({ type:"VIRTUAL", state:"OPEN" }) — the agent's card (token).
 *  - applyPolicy     -> cards.update spend_limit + spend_limit_duration (per-tx / daily).
 *  - freeze          -> cards.update({ state:"PAUSED" }) — declines every auth, reversible. Confirmed
 *                       by reading the card state back (never trust the call resolving alone).
 *  - revokeSession   -> cards.update({ state:"CLOSED" }) — the irreversible kill.
 *
 * Countersign stays the CONTROL PLANE, never the issuer/custodian: it governs the customer's own Lithic
 * program via their API key (same as it governs their Coinbase via CDP keys) — no funds held, no PCI
 * PAN handling (we act at the issuing API; the auth-stream is tokenized). Defaults to the SANDBOX
 * environment (directive #6: testnet only). ASA (Authorization Stream Access) real-time approve/decline
 * is the supportsInlineApproval upgrade; merchant/MCC allowlists are Auth Rules (a UnifiedPolicy
 * extension). Needs LITHIC_API_KEY to run; see docs/sdk-research/lithic.md.
 */

import Lithic from "lithic";
import {
  asProviderId,
  nextId,
  type AgentId,
  type AgentRef,
  type EnforcementProvider,
  type FreezeResult,
  type FreezeScope,
  type HealthStatus,
  type ProviderCapabilities,
  type ProviderEvent,
  type Unsubscribe,
  type Venue,
} from "@countersign/core";
import type { UnifiedPolicy } from "@countersign/policy";

export interface LithicConfig {
  apiKey?: string;
  /** "sandbox" (default, testnet-safe) or "production". */
  environment?: "sandbox" | "production";
}

interface LithicAgent {
  cardToken: string;
  lastFour: string;
  policyId?: string;
}

export class LithicProvider implements EnforcementProvider {
  readonly id = asProviderId("lithic");

  private lithic: Lithic | undefined;
  private readonly agents = new Map<AgentId, LithicAgent>();
  private readonly frozen = new Set<AgentId>();
  private providerFrozen = false;
  private readonly handlers = new Set<(e: ProviderEvent) => void>();

  constructor(private readonly config: LithicConfig = {}) {}

  /** Lazy — so the provider can be constructed (and capabilities() read) without credentials. */
  private client(): Lithic {
    if (!this.lithic) {
      const apiKey = this.config.apiKey ?? process.env["LITHIC_API_KEY"];
      if (!apiKey) throw new Error("lithic: missing credentials (LITHIC_API_KEY)");
      // Fail safe to sandbox; only go to production on an explicit opt-in (directive #6).
      const environment =
        this.config.environment ?? (process.env["LITHIC_ENV"] === "production" ? "production" : "sandbox");
      this.lithic = new Lithic({ apiKey, environment });
    }
    return this.lithic;
  }

  async capabilities(): Promise<ProviderCapabilities> {
    return {
      enforcementMode: "native-session-caps", // card spend_limit enforced by Lithic/Visa
      supportsInlineApproval: false, // ASA auth-stream (per-auth approve/decline) is the upgrade
      supportsOnchainGuard: false,
      supportsSessionRevocation: true, // close the card
      realtimeEvents: false, // auth-stream webhooks / Events API not wired yet
      venues: ["visa"],
    };
  }

  async provisionWallet(agentId: AgentId, opts: { venue: Venue }): Promise<AgentRef> {
    const card = await this.client().cards.create({ type: "VIRTUAL", state: "OPEN", memo: `countersign-${String(agentId)}` });
    this.agents.set(agentId, { cardToken: card.token, lastFour: card.last_four });
    // The "wallet" handle is the masked card, never the PAN.
    return { provider: this.id, agentId, wallet: `card-****${card.last_four}`, venue: opts.venue };
  }

  /**
   * Map the unified policy to the card's native spend control. NOTE: for a card rail, perTxCap /
   * dailyCap are interpreted as MINOR UNITS (cents). A card has ONE native spend_limit+duration, so a
   * per-tx cap binds as TRANSACTION; a daily cap as DAILY; if both are set the per-tx cap wins
   * natively and the other is Countersign-enforced (never silently dropped). Crypto-style address
   * allow/denylists don't apply to cards — merchant/MCC controls are Lithic Auth Rules (future).
   */
  async applyPolicy(agentId: AgentId, policy: UnifiedPolicy): Promise<{ policyId: string }> {
    const a = this.require(agentId);
    const countersignTracked: string[] = [];

    // The card's native spend_limit binds the per-tx cap (TRANSACTION duration). dailyCap stays
    // Countersign-enforced — Lithic's update API expresses ANNUALLY/MONTHLY/FOREVER/TRANSACTION but not a
    // rolling DAILY window, so we don't approximate it natively (never silently weaken/strengthen).
    const spendLimit = policy.perTxCap !== undefined ? Number(policy.perTxCap) : undefined;
    if (policy.dailyCap !== undefined) countersignTracked.push("dailyCap (card native limit is per-transaction)");
    if (policy.allowlist?.length) countersignTracked.push("allowlist (-> Lithic Auth Rules / MCC)");
    if (policy.denylist?.length) countersignTracked.push("denylist (-> Lithic Auth Rules / MCC)");
    if (policy.approvalThreshold !== undefined) countersignTracked.push("approvalThreshold (-> ASA auth-stream)");

    if (spendLimit !== undefined) {
      await this.client().cards.update(a.cardToken, { spend_limit: spendLimit, spend_limit_duration: "TRANSACTION" });
    }

    const policyId = nextId("pol");
    a.policyId = policyId;
    this.emit({ type: "policy_applied", agentId, policyId, ts: Date.now() });
    if (countersignTracked.length > 0) {
      this.emit({ type: "error", agentId, message: `countersign-tracked (not native): ${countersignTracked.join(", ")}`, ts: Date.now() });
    }
    return { policyId };
  }

  /**
   * Hard stop. Pauses each target card so Lithic/Visa declines every authorization — confirmed by
   * reading the card state back (PAUSED). Fail-closed: confirmed:false if any card can't be confirmed
   * paused. Idempotent. Reversible via unfreeze (PAUSED -> OPEN).
   */
  async freeze(scope: FreezeScope): Promise<FreezeResult> {
    if (scope.kind === "provider-all") this.providerFrozen = true;
    const targets: AgentId[] = scope.kind === "provider-all" ? [...this.agents.keys()] : [scope.agentId];
    const client = this.client();

    const results = await Promise.allSettled(
      targets.map(async (id) => {
        if (this.frozen.has(id)) return id; // idempotent
        const a = this.require(id);
        const card = await client.cards.update(a.cardToken, { state: "PAUSED" });
        if (card.state !== "PAUSED") throw new Error(`lithic: card ${id} not confirmed PAUSED (state=${card.state})`);
        this.frozen.add(id);
        this.emit({ type: "frozen", scope: { kind: "agent", agentId: id }, mechanism: "caps-zeroed", ts: Date.now() });
        return id;
      }),
    );

    const frozenAgents: AgentId[] = [];
    let confirmed = true;
    for (const r of results) {
      if (r.status === "fulfilled") frozenAgents.push(r.value);
      else confirmed = false; // unconfirmed pause => still dangerous => controller escalates
    }
    return { confirmed, frozenAgents, mechanism: "caps-zeroed", at: Date.now() };
  }

  async unfreeze(scope: FreezeScope): Promise<void> {
    if (scope.kind === "provider-all") this.providerFrozen = false;
    const targets: AgentId[] = scope.kind === "provider-all" ? [...this.agents.keys()] : [scope.agentId];
    const client = this.client();
    for (const id of targets) {
      const a = this.agents.get(id);
      if (!a || !this.frozen.has(id)) continue;
      await client.cards.update(a.cardToken, { state: "OPEN" });
      this.frozen.delete(id);
      this.emit({ type: "unfrozen", scope: { kind: "agent", agentId: id }, ts: Date.now() });
    }
  }

  /** The irreversible kill: CLOSE the card — it can never approve an authorization again. */
  async revokeSession(agentId: AgentId): Promise<void> {
    const a = this.require(agentId);
    await this.client().cards.update(a.cardToken, { state: "CLOSED" });
    this.frozen.add(agentId);
    this.emit({ type: "session_revoked", agentId, ts: Date.now() });
  }

  subscribe(handler: (event: ProviderEvent) => void): Unsubscribe {
    // Phase-2: Lithic Events API / auth-stream webhooks (real-time authorization events).
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  async health(): Promise<HealthStatus> {
    try {
      const t0 = Date.now();
      await this.client().cards.list();
      return { healthy: true, latencyMs: Date.now() - t0, detail: "lithic: live (sandbox)" };
    } catch (err) {
      return { healthy: false, detail: `lithic: ${err instanceof Error ? err.message : String(err)}` };
    }
  }

  /* ---- accessors (for spikes / observability) ---- */

  getAgent(agentId: AgentId): Readonly<LithicAgent> | undefined {
    return this.agents.get(agentId);
  }

  isProviderFrozen(): boolean {
    return this.providerFrozen;
  }

  /* ---- internals ---- */

  private require(agentId: AgentId): LithicAgent {
    const a = this.agents.get(agentId);
    if (!a) throw new Error(`lithic: agent ${String(agentId)} has no provisioned card`);
    return a;
  }

  private emit(event: ProviderEvent): void {
    for (const h of this.handlers) h(event);
  }
}
