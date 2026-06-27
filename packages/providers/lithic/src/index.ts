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
  type ActionRequest,
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
  /**
   * Enable ASA (Authorization Stream Access): Countersign decides each authorization in real time via
   * `decideAuthorization` (the webhook handler calls it). This is what makes `dailyCap` and
   * `approvalThreshold` ENFORCED on the card — the static `spend_limit` can only express a per-tx cap.
   * Off by default; turn on once the ASA webhook is enrolled with Lithic (see docs/sdk-research/lithic.md).
   */
  asaEnabled?: boolean;
}

interface LithicAgent {
  cardToken: string;
  lastFour: string;
  policyId?: string;
  /** Retained for the ASA real-time decision (the static card limit can't express daily/approval). */
  policy?: UnifiedPolicy;
  /** Rolling daily total (minor units / cents), reserved on each ASA approval. */
  dailySpent: string;
}

/** An incoming Lithic ASA authorization request (the fields Countersign's policy decides on). */
export interface AsaAuthorization {
  cardToken: string;
  /** Requested amount in MINOR UNITS (cents) — same denomination as the card's caps. */
  amount: string;
  merchant?: { descriptor?: string; mcc?: string };
}

/** Countersign's real-time verdict for an ASA authorization. */
export interface AsaDecision {
  approved: boolean;
  reason: string;
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
    this.agents.set(agentId, { cardToken: card.token, lastFour: card.last_four, dailySpent: "0" });
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
    a.policy = policy; // retained for the ASA real-time decision
    const asa = this.config.asaEnabled === true;
    const countersignTracked: string[] = [];

    // The card's native spend_limit binds the per-tx cap (TRANSACTION duration). dailyCap can't be a
    // rolling DAILY window in Lithic's update API — but with ASA on, Countersign enforces it (and the
    // approval threshold) in real time per authorization, so they're no longer merely "tracked".
    const spendLimit = policy.perTxCap !== undefined ? Number(policy.perTxCap) : undefined;
    if (policy.dailyCap !== undefined && !asa) countersignTracked.push("dailyCap (card native limit is per-transaction; enable ASA to enforce)");
    if (policy.approvalThreshold !== undefined && !asa) countersignTracked.push("approvalThreshold (-> ASA auth-stream)");
    if (policy.allowlist?.length) countersignTracked.push("allowlist (-> Lithic Auth Rules / MCC)");
    if (policy.denylist?.length) countersignTracked.push("denylist (-> Lithic Auth Rules / MCC)");

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
   * ASA (Authorization Stream Access) real-time decision. Lithic streams each pending authorization to
   * our webhook, which calls this and returns approve/decline inside Visa's window. This is where
   * dailyCap + approvalThreshold actually BIND on the card — the static spend_limit only carries a
   * per-tx cap. FAIL-CLOSED: anything we can't positively allow is declined. Synchronous with no await,
   * so the daily-tally reserve is atomic on the single-threaded loop (no check→reserve TOCTOU).
   * Every decision is emitted (action_allowed / action_blocked) so the ledger audits the card too.
   */
  decideAuthorization(auth: AsaAuthorization): AsaDecision {
    const found = [...this.agents].find(([, a]) => a.cardToken === auth.cardToken);
    if (!found) {
      this.emit({ type: "error", message: "asa: unknown card token — declined (default deny)", ts: Date.now() });
      return { approved: false, reason: "unknown card token (default deny)" };
    }
    const [agentId, a] = found;
    const action: ActionRequest = {
      id: nextId("act"),
      agentId,
      kind: "transfer",
      asset: a.policy?.asset ?? "USD",
      amount: auth.amount,
      ...(auth.merchant?.descriptor ? { counterparty: auth.merchant.descriptor } : {}),
      venue: "visa" as Venue,
      raw: auth,
      ts: Date.now(),
    };
    const policyId = a.policyId ?? "none";
    const decline = (reason: string): AsaDecision => {
      this.emit({ type: "action_blocked", agentId, action, policyId, reason, ts: Date.now() });
      return { approved: false, reason };
    };

    if (this.providerFrozen || this.frozen.has(agentId)) return decline("card frozen");
    const policy = a.policy;
    if (!policy) return decline("no policy applied (default deny)");

    let amt: bigint;
    try {
      amt = BigInt(auth.amount);
    } catch {
      return decline("invalid authorization amount");
    }
    if (amt < 0n) return decline("invalid authorization amount");

    if (policy.perTxCap !== undefined && amt > BigInt(policy.perTxCap)) return decline("per-transaction cap exceeded");
    // A card auth can't be held for async human approval inside Visa's window, so above the approval
    // threshold we DECLINE (fail-closed) rather than auto-approve a spend a human was meant to gate.
    if (policy.approvalThreshold !== undefined && amt > BigInt(policy.approvalThreshold)) {
      return decline("above approval threshold (no inline human approval on a card authorization)");
    }
    if (policy.dailyCap !== undefined) {
      const next = BigInt(a.dailySpent) + amt;
      if (next > BigInt(policy.dailyCap)) return decline("rolling daily cap exceeded");
      a.dailySpent = next.toString(); // reserve on approve
    }
    this.emit({ type: "action_allowed", agentId, action, policyId, ts: Date.now() });
    return { approved: true, reason: "within policy" };
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
