/**
 * Openfort adapter — LIVE (testnet-safe). EnforcementMode = onchain-policy.
 *
 * What's real here (verified against @openfort/openfort-node v0.10.5):
 *  - provisionWallet -> accounts.evm.backend.create() — a backend wallet (developer-custody EOA held
 *                       in Openfort's TEE; the agent's signer).
 *  - freeze          -> accounts.evm.backend.delete(accountId) — a CONFIRMED hard stop: the signer is
 *                       destroyed, so it can never sign again (confirmed via { deleted: true }).
 *  - applyPolicy     -> compiles the unified policy to the on-chain shape and retains it Countersign-side.
 *
 * The freeze here is custody-level (the signer is removed), which is why supportsOnchainGuard is false
 * for now: the full on-chain guard — `update` the EOA to an EIP-7702 delegated account, create a
 * scoped session key, and drive KeysManager `pauseKey`/`revokeKey` verified by `isKeyActive` — is the
 * hardening step (mirrors how Coinbase's native MPC cap was staged after the Countersign-layer gate). See
 * docs/sdk-research/openfort.md. Testnet only (directive #6); Openfort backend wallets are chain-agnostic.
 */

import Openfort from "@openfort/openfort-node";
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
import { compile, type OpenfortOnchainPolicy, type UnifiedPolicy } from "@countersign/policy";

export interface OpenfortConfig {
  secretKey?: string;
  walletSecret?: string;
}

interface OpenfortAgent {
  accountId: string; // acc_...
  address: string;
  policyId?: string;
}

export class OpenfortProvider implements EnforcementProvider {
  readonly id = asProviderId("openfort");

  private openfort: Openfort | undefined;
  private readonly agents = new Map<AgentId, OpenfortAgent>();
  private readonly frozen = new Set<AgentId>();
  private providerFrozen = false;
  private readonly handlers = new Set<(e: ProviderEvent) => void>();

  constructor(private readonly config: OpenfortConfig = {}) {}

  /** Lazy — so the provider can be constructed (and capabilities() read) without credentials. */
  private client(): Openfort {
    if (!this.openfort) {
      const secretKey = this.config.secretKey ?? process.env["OPENFORT_SECRET_KEY"];
      const walletSecret = this.config.walletSecret ?? process.env["OPENFORT_WALLET_SECRET"];
      if (!secretKey || !walletSecret) {
        throw new Error("openfort: missing credentials (OPENFORT_SECRET_KEY / OPENFORT_WALLET_SECRET)");
      }
      this.openfort = new Openfort(secretKey, { walletSecret });
    }
    return this.openfort;
  }

  async capabilities(): Promise<ProviderCapabilities> {
    return {
      enforcementMode: "onchain-policy",
      supportsInlineApproval: false,
      supportsOnchainGuard: false, // v1 freeze is custody-level (delete the signer); on-chain KeysManager guard is the hardening step
      supportsSessionRevocation: true, // delete the backend wallet
      realtimeEvents: false, // transaction_intent webhooks not wired yet
      venues: ["polygon-amoy", "base-sepolia"],
    };
  }

  async provisionWallet(agentId: AgentId, opts: { venue: Venue }): Promise<AgentRef> {
    const account = await this.client().accounts.evm.backend.create();
    this.agents.set(agentId, { accountId: account.id, address: account.address });
    return { provider: this.id, agentId, wallet: account.address, venue: opts.venue };
  }

  /**
   * Compile the unified policy to Openfort's on-chain shape (session scope + canCall allowlist +
   * tokenSpend). v1 retains it Countersign-side (the pre-flight gate); the on-chain KeysManager push is the
   * hardening step. Recorded so the policy is auditable in the ledger.
   */
  async applyPolicy(agentId: AgentId, policy: UnifiedPolicy): Promise<{ policyId: string }> {
    const a = this.require(agentId);
    const native: OpenfortOnchainPolicy = compile(policy, "onchain-policy");
    void native; // canCall/tokenSpend/session map to KeysManager on-chain (hardening); unsupported fields stay Countersign-enforced
    const policyId = nextId("pol");
    a.policyId = policyId;
    this.emit({ type: "policy_applied", agentId, policyId, ts: Date.now() });
    // Be honest + auditable: the policy is enforced at the Countersign pre-flight layer; the on-chain
    // KeysManager guard (supportsOnchainGuard=false) is NOT wired yet, so native on-chain enforcement
    // is not confirmed. Surface it in the ledger rather than implying a native guarantee.
    this.emit({ type: "error", agentId, message: "openfort: Countersign-layer enforcement only — on-chain KeysManager guard not yet active", ts: Date.now() });
    return { policyId };
  }

  /**
   * Hard stop. Deletes the agent's backend wallet so Openfort can no longer sign for it — confirmed
   * by the API's { deleted: true }. Fail-closed: confirmed:false if any target can't be confirmed
   * deleted. Idempotent (a frozen agent is skipped and still reported confirmed).
   */
  async freeze(scope: FreezeScope): Promise<FreezeResult> {
    if (scope.kind === "provider-all") this.providerFrozen = true;
    const targets: AgentId[] = scope.kind === "provider-all" ? [...this.agents.keys()] : [scope.agentId];
    const client = this.client();

    const results = await Promise.allSettled(
      targets.map(async (id) => {
        if (this.frozen.has(id)) return id; // idempotent
        const a = this.require(id);
        const res = await client.accounts.evm.backend.delete(a.accountId);
        if (!res.deleted) throw new Error(`openfort: delete not confirmed for ${String(id)}`);
        this.frozen.add(id);
        this.emit({ type: "frozen", scope: { kind: "agent", agentId: id }, mechanism: "session-revoked", ts: Date.now() });
        return id;
      }),
    );

    const frozenAgents: AgentId[] = [];
    let confirmed = true;
    for (const r of results) {
      if (r.status === "fulfilled") frozenAgents.push(r.value);
      else confirmed = false; // unconfirmed delete => still dangerous => controller escalates
    }
    return { confirmed, frozenAgents, mechanism: "session-revoked", at: Date.now() };
  }

  async unfreeze(scope: FreezeScope): Promise<void> {
    // NOTE: deleting a backend wallet is irreversible — a reversible freeze needs the on-chain
    // pauseKey/unpauseKey path. v1 clears local state so the demo can re-provision.
    if (scope.kind === "provider-all") {
      this.providerFrozen = false;
      this.frozen.clear();
    } else {
      this.frozen.delete(scope.agentId);
    }
    this.emit({ type: "unfrozen", scope, ts: Date.now() });
  }

  /** The hard kill (same mechanism as freeze for a backend wallet: the signer is destroyed). */
  async revokeSession(agentId: AgentId): Promise<void> {
    const a = this.require(agentId);
    if (!this.frozen.has(agentId)) {
      const res = await this.client().accounts.evm.backend.delete(a.accountId);
      if (res.deleted) this.frozen.add(agentId);
    }
    this.emit({ type: "session_revoked", agentId, ts: Date.now() });
  }

  subscribe(handler: (event: ProviderEvent) => void): Unsubscribe {
    // Phase-2: transaction_intent webhooks + Events API poll.
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  async health(): Promise<HealthStatus> {
    try {
      const t0 = Date.now();
      await this.client().accounts.evm.backend.list({ limit: 1 });
      return { healthy: true, latencyMs: Date.now() - t0, detail: "openfort: live" };
    } catch (err) {
      return { healthy: false, detail: `openfort: ${err instanceof Error ? err.message : String(err)}` };
    }
  }

  /* ---- accessors (for spikes / observability) ---- */

  getAgent(agentId: AgentId): Readonly<OpenfortAgent> | undefined {
    return this.agents.get(agentId);
  }

  isProviderFrozen(): boolean {
    return this.providerFrozen;
  }

  /* ---- internals ---- */

  private require(agentId: AgentId): OpenfortAgent {
    const a = this.agents.get(agentId);
    if (!a) throw new Error(`openfort: agent ${String(agentId)} has no provisioned wallet`);
    return a;
  }

  private emit(event: ProviderEvent): void {
    for (const h of this.handlers) h(event);
  }
}
