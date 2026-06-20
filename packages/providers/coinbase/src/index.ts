/**
 * Coinbase Agentic Wallets adapter — SKELETON. EnforcementMode = native-session-caps.
 *
 * Signatures and capabilities are real; the live SDK calls throw NotImplementedError until
 * credentials exist. To finish: `pnpm add @coinbase/cdp-sdk` and fill the TODOs per
 * docs/sdk-research/coinbase.md. NEVER reconstruct keys (prime directive #1) — the Wallet Secret
 * signs inside Coinbase's TEE; we only orchestrate spend permissions + policies.
 */

import {
  NotImplementedError,
  asProviderId,
  type ActionRequest,
  type AgentId,
  type AgentRef,
  type Decision,
  type EnforcementProvider,
  type FreezeResult,
  type FreezeScope,
  type HealthStatus,
  type ProviderCapabilities,
  type ProviderEvent,
  type Unsubscribe,
  type Venue,
} from "@cosign/core";
import { compile, type UnifiedPolicy } from "@cosign/policy";

export interface CoinbaseConfig {
  apiKeyId?: string;
  apiKeySecret?: string;
  walletSecret?: string;
}

export class CoinbaseProvider implements EnforcementProvider {
  readonly id = asProviderId("coinbase");
  constructor(private readonly config: CoinbaseConfig = {}) {}

  async capabilities(): Promise<ProviderCapabilities> {
    return {
      enforcementMode: "native-session-caps",
      supportsInlineApproval: false, // caps are autonomous; breaches surface as action_blocked
      supportsOnchainGuard: false, // enforced in MPC + Spend Permission Manager, not a custom guard
      supportsSessionRevocation: true, // revokeSpendPermission
      realtimeEvents: false, // webhooks only (no ws) — adapter must poll/reconcile
      venues: ["base-sepolia"],
    };
  }

  async provisionWallet(_agentId: AgentId, _opts: { venue: Venue }): Promise<AgentRef> {
    // TODO(creds): cdp.evm.createAccount() then cdp.evm.createSmartAccount({ owner }).
    throw new NotImplementedError("CoinbaseProvider.provisionWallet");
  }

  async applyPolicy(_agentId: AgentId, policy: UnifiedPolicy): Promise<{ policyId: string }> {
    const native = compile(policy, "native-session-caps");
    // TODO(creds): push `native` via @coinbase/cdp-sdk:
    //   native.spendPermission -> cdp.evm.createSpendPermission({ network, spendPermission })  (daily cap)
    //   native.policy.rules    -> cdp.policies.createPolicy({ policy: { scope, rules } })        (per-tx + allow/deny)
    //   native.unsupported (e.g. approvalThreshold) is enforced by Cosign, not Coinbase.
    void native;
    throw new NotImplementedError("CoinbaseProvider.applyPolicy");
  }

  // No native inline approval on caps-only backends — evaluate/approve/deny intentionally omitted.
  async evaluate(_action: ActionRequest): Promise<Decision> {
    throw new NotImplementedError("CoinbaseProvider.evaluate (caps are enforced autonomously)");
  }

  async freeze(_scope: FreezeScope): Promise<FreezeResult> {
    // TODO(creds): cdp.evm.revokeSpendPermission({ address, permissionHash, network })  (idempotent)
    //   — or attach a reject-all Policy. Return { confirmed:false } if the userOp can't be confirmed.
    throw new NotImplementedError("CoinbaseProvider.freeze");
  }

  async unfreeze(_scope: FreezeScope): Promise<void> {
    throw new NotImplementedError("CoinbaseProvider.unfreeze");
  }

  async revokeSession(_agentId: AgentId): Promise<void> {
    // TODO(creds): revoke the spender's Spend Permission for a hard stop.
    throw new NotImplementedError("CoinbaseProvider.revokeSession");
  }

  subscribe(_handler: (event: ProviderEvent) => void): Unsubscribe {
    // TODO(creds): cdp.webhooks.createSubscription({ eventTypes, targetUrl }); poll to reconcile
    // the 3-min monitoring window. Skeleton emits nothing.
    return () => {};
  }

  async health(): Promise<HealthStatus> {
    return { healthy: false, detail: "coinbase adapter: skeleton, no credentials configured" };
  }
}
