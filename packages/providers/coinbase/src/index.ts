/**
 * Coinbase Agentic Wallets adapter — LIVE on Base Sepolia (testnet). EnforcementMode =
 * native-session-caps.
 *
 * What's real here: provisioning a CDP wallet (`createAccount`), funding it (`requestFaucet`), and
 * sending actual on-chain transactions (`sendTransaction`) — all verified against the installed SDK.
 * Countersign governs each spend: a spend only executes if the unified policy allows it and the agent
 * isn't frozen/revoked. So a Countersign freeze provably prevents the next transaction (it is never sent).
 *
 * Enforcement here is at the COUNTERSIGN layer (the agent transacts through Countersign). Pushing the caps
 * down into Coinbase's own MPC (Spend Permissions + Policy engine) so even a compromised agent can't
 * bypass them is the hardening step — verify `createSpendPermission` / `policies.createPolicy`
 * against the installed SDK first (see docs/sdk-research/coinbase.md). Testnet only (directive #6).
 */

import { CdpClient } from "@coinbase/cdp-sdk";
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
import { compile, evaluatePolicy, type SpendAttempt, type UnifiedPolicy } from "@countersign/policy";

export type CoinbaseSpendResult =
  | { outcome: "allowed"; action: ActionRequest; transactionHash: string }
  | { outcome: "blocked"; action: ActionRequest; reason: string }
  | { outcome: "needs_approval"; action: ActionRequest; approvalToken: string; reason: string };

export class CoinbaseProvider implements EnforcementProvider {
  readonly id = asProviderId("coinbase");

  private cdp: CdpClient | undefined;
  private readonly accounts = new Map<AgentId, { address: `0x${string}` }>();
  private readonly policies = new Map<AgentId, UnifiedPolicy>();
  private readonly policyIds = new Map<AgentId, string>();
  private readonly dailySpent = new Map<AgentId, string>();
  private readonly revoked = new Set<AgentId>();
  private readonly frozenAgents = new Set<AgentId>();
  private providerFrozen = false;
  private readonly handlers = new Set<(e: ProviderEvent) => void>();
  /** Native CDP policy id attached to each agent's account (the cap enforced in Coinbase's MPC). */
  private readonly nativePolicyId = new Map<AgentId, string>();
  private readonly nativeStatus = new Map<AgentId, string>();

  /** Lazy — so the provider can be constructed (and capabilities() read) without credentials. */
  private client(): CdpClient {
    return (this.cdp ??= new CdpClient());
  }

  async capabilities(): Promise<ProviderCapabilities> {
    return {
      enforcementMode: "native-session-caps",
      supportsInlineApproval: false,
      supportsOnchainGuard: false,
      supportsSessionRevocation: true,
      realtimeEvents: false, // CDP is webhook-based; this adapter mediates spends synchronously
      venues: ["base-sepolia"],
    };
  }

  async provisionWallet(agentId: AgentId, opts: { venue: Venue }): Promise<AgentRef> {
    const account = await this.client().evm.createAccount();
    this.accounts.set(agentId, { address: account.address });
    this.dailySpent.set(agentId, "0");
    return { provider: this.id, agentId, wallet: account.address, venue: opts.venue };
  }

  /** Fund an agent wallet from the testnet faucet. Returns the faucet tx hash. */
  async fund(agentId: AgentId, opts: { venue: Venue; token?: "eth" | "usdc" }): Promise<string> {
    const acct = this.require(agentId);
    const { transactionHash } = await this.client().evm.requestFaucet({
      address: acct.address,
      network: opts.venue as "base-sepolia",
      token: opts.token ?? "eth",
    });
    return transactionHash;
  }

  async applyPolicy(agentId: AgentId, policy: UnifiedPolicy): Promise<{ policyId: string }> {
    // Countersign retains the policy and governs each spend (pre-flight). The compiled native controls
    // below are what a future hardening step pushes into Coinbase's MPC; not relied on for the gate.
    void compile(policy, "native-session-caps");
    this.policies.set(agentId, policy);
    const policyId = nextId("pol");
    this.policyIds.set(agentId, policyId);
    if (!this.dailySpent.has(agentId)) this.dailySpent.set(agentId, "0");
    // HARDENING — push the per-tx cap into Coinbase's own MPC (an account policy) so it's enforced
    // even if Countersign's pre-check is bypassed. Best-effort: a failure leaves Countersign-layer enforcement.
    let status = policy.perTxCap ? "pending" : "n/a (no per-tx cap)";
    if (policy.perTxCap) {
      try {
        status = `native cap active (policy ${await this.pushNative(agentId, policy)})`;
      } catch (err) {
        status = `native push failed (Countersign-layer still enforces): ${err instanceof Error ? err.message : String(err)}`;
      }
    }
    this.nativeStatus.set(agentId, status);
    this.emit({ type: "policy_applied", agentId, policyId, ts: Date.now() });
    return { policyId };
  }

  async freeze(scope: FreezeScope): Promise<FreezeResult> {
    if (scope.kind === "provider-all") this.providerFrozen = true;
    else this.frozenAgents.add(scope.agentId);
    const frozenAgents = scope.kind === "provider-all" ? [...this.accounts.keys()] : [scope.agentId];
    // Best-effort NATIVE freeze: attach a deny-all account policy so Coinbase rejects even a direct send.
    await Promise.all(frozenAgents.map((a) => this.nativeFreeze(a).catch(() => undefined)));
    this.emit({ type: "frozen", scope, mechanism: "policy-deny", ts: Date.now() });
    return { confirmed: true, frozenAgents, mechanism: "policy-deny", at: Date.now() };
  }

  async unfreeze(scope: FreezeScope): Promise<void> {
    if (scope.kind === "provider-all") {
      this.providerFrozen = false;
      this.frozenAgents.clear();
    } else {
      this.frozenAgents.delete(scope.agentId);
    }
    this.emit({ type: "unfrozen", scope, ts: Date.now() });
  }

  async revokeSession(agentId: AgentId): Promise<void> {
    this.revoked.add(agentId);
    this.emit({ type: "session_revoked", agentId, ts: Date.now() });
  }

  /**
   * The gated spend: Countersign decides, then — only if allowed — a REAL transaction is sent on-chain.
   * When frozen/over-policy, no transaction is ever sent: the freeze provably prevents it.
   */
  async attemptSpend(agentId: AgentId, attempt: SpendAttempt): Promise<CoinbaseSpendResult> {
    const action = this.toAction(agentId, attempt);
    const policyId = this.policyIds.get(agentId) ?? "none";
    this.emit({ type: "action_requested", agentId, action, ts: Date.now() });

    if (this.revoked.has(agentId)) return this.block(agentId, action, policyId, "session revoked");
    if (this.providerFrozen || this.frozenAgents.has(agentId)) return this.block(agentId, action, policyId, "frozen");
    const policy = this.policies.get(agentId);
    if (!policy) return this.block(agentId, action, policyId, "no policy (default deny)");

    const decision = evaluatePolicy(policy, attempt, { dailySpent: this.dailySpent.get(agentId) });
    if (decision.outcome === "deny") return this.block(agentId, action, policyId, decision.reason);
    if (decision.outcome === "needs_approval") {
      const approvalToken = nextId("appr");
      this.emit({ type: "needs_approval", agentId, action, approvalToken, reason: decision.reason, ts: Date.now() });
      return { outcome: "needs_approval", action, approvalToken, reason: decision.reason };
    }

    const acct = this.require(agentId);
    const to = (attempt.counterparty ?? acct.address) as `0x${string}`;
    const { transactionHash } = await this.client().evm.sendTransaction({
      address: acct.address,
      transaction: { to, value: BigInt(attempt.amount) },
      network: attempt.venue as "base-sepolia",
    });
    if (attempt.asset === policy.asset) {
      const prior = this.dailySpent.get(agentId) ?? "0";
      this.dailySpent.set(agentId, (BigInt(prior) + BigInt(attempt.amount)).toString());
    }
    const allowedAction: ActionRequest = { ...action, raw: { transactionHash } };
    this.emit({ type: "action_allowed", agentId, action: allowedAction, policyId, ts: Date.now() });
    return { outcome: "allowed", action: allowedAction, transactionHash };
  }

  subscribe(handler: (event: ProviderEvent) => void): Unsubscribe {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  async health(): Promise<HealthStatus> {
    return { healthy: true, detail: "coinbase: live (Base Sepolia)" };
  }

  /* ---- native hardening (caps enforced inside Coinbase's MPC, not just Countersign's pre-check) ---- */

  /** Create a CDP account policy for the per-tx cap and attach it to the agent's account. */
  private async pushNative(agentId: AgentId, policy: UnifiedPolicy): Promise<string> {
    const acct = this.require(agentId);
    const created = await this.client().policies.createPolicy({
      policy: {
        scope: "account",
        description: "countersign per tx cap",
        // An operation with any rule defaults to DENY unless an `accept` matches — so we ACCEPT only
        // transactions at/under the cap; over-cap finds no accept rule and is denied by Coinbase.
        rules: [
          { action: "accept", operation: "signEvmTransaction", criteria: [{ type: "ethValue", ethValue: policy.perTxCap!, operator: "<=" }] },
          { action: "accept", operation: "sendEvmTransaction", criteria: [{ type: "ethValue", ethValue: policy.perTxCap!, operator: "<=" }] },
        ],
      },
    });
    await this.client().evm.updateAccount({ address: acct.address, update: { accountPolicy: created.id } });
    this.nativePolicyId.set(agentId, created.id);
    return created.id;
  }

  /** Attach a deny-all account policy so Coinbase rejects every signature for this agent. */
  private async nativeFreeze(agentId: AgentId): Promise<void> {
    const acct = this.accounts.get(agentId);
    if (!acct) return;
    const created = await this.client().policies.createPolicy({
      policy: {
        scope: "account",
        description: "countersign freeze deny all",
        rules: [
          { action: "reject", operation: "signEvmTransaction", criteria: [] },
          { action: "reject", operation: "sendEvmTransaction", criteria: [] },
        ],
      },
    });
    await this.client().evm.updateAccount({ address: acct.address, update: { accountPolicy: created.id } });
  }

  /**
   * Send a transaction DIRECTLY, bypassing Countersign's pre-flight gate — used to prove the native
   * account policy enforces the cap inside Coinbase even when Countersign is skipped (a stand-in for a
   * compromised agent). Throws if Coinbase's policy rejects the signature.
   */
  async nativeSendUnchecked(agentId: AgentId, opts: { to: string; amountWei: string; venue: Venue }): Promise<string> {
    const acct = this.require(agentId);
    const { transactionHash } = await this.client().evm.sendTransaction({
      address: acct.address,
      transaction: { to: opts.to as `0x${string}`, value: BigInt(opts.amountWei) },
      network: opts.venue as "base-sepolia",
    });
    return transactionHash;
  }

  getNativeStatus(agentId: AgentId): string {
    return this.nativeStatus.get(agentId) ?? "none";
  }

  getNativePolicyId(agentId: AgentId): string | undefined {
    return this.nativePolicyId.get(agentId);
  }

  /* ---- internals ---- */

  private require(agentId: AgentId): { address: `0x${string}` } {
    const acct = this.accounts.get(agentId);
    if (!acct) throw new Error(`coinbase: agent ${agentId} has no provisioned wallet`);
    return acct;
  }

  private block(agentId: AgentId, action: ActionRequest, policyId: string, reason: string): CoinbaseSpendResult {
    this.emit({ type: "action_blocked", agentId, action, policyId, reason, ts: Date.now() });
    return { outcome: "blocked", action, reason };
  }

  private toAction(agentId: AgentId, attempt: SpendAttempt): ActionRequest {
    return {
      id: nextId("act"),
      agentId,
      kind: "transfer",
      asset: attempt.asset,
      amount: attempt.amount,
      venue: attempt.venue,
      ts: Date.now(),
      ...(attempt.counterparty !== undefined ? { counterparty: attempt.counterparty } : {}),
    };
  }

  private emit(event: ProviderEvent): void {
    for (const h of this.handlers) h(event);
  }
}
