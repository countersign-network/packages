/**
 * Openfort adapter — SKELETON. EnforcementMode = onchain-policy (session-key scope enforced
 * on-chain in the ERC-4337 / EIP-7702 KeysManager; freeze = pauseKey / revokeKey).
 *
 * To finish: `pnpm add @openfort/openfort-node` and fill the TODOs per docs/sdk-research/openfort.md.
 * For a true on-chain guard, drive KeysManager.pauseKey/revokeKey and verify via isKeyActive — do
 * NOT trust the API call merely resolving (fail-closed).
 */

import {
  NotImplementedError,
  asProviderId,
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
} from "@cosign/core";
import { compile, type OpenfortOnchainPolicy, type UnifiedPolicy } from "@cosign/policy";

export interface OpenfortConfig {
  secretKey?: string;
  walletSecret?: string;
}

export class OpenfortProvider implements EnforcementProvider {
  readonly id = asProviderId("openfort");
  constructor(private readonly config: OpenfortConfig = {}) {}

  async capabilities(): Promise<ProviderCapabilities> {
    return {
      enforcementMode: "onchain-policy",
      supportsInlineApproval: false, // no inline human approval on-chain
      supportsOnchainGuard: true, // KeysManager pause/revoke is the strongest guarantee
      supportsSessionRevocation: true,
      realtimeEvents: true, // transaction_intent webhooks
      venues: ["base-sepolia", "polygon-amoy"],
    };
  }

  async provisionWallet(_agentId: AgentId, _opts: { venue: Venue }): Promise<AgentRef> {
    // TODO(creds): openfort.accounts.evm.backend.create() (chainId per venue).
    throw new NotImplementedError("OpenfortProvider.provisionWallet");
  }

  async applyPolicy(_agentId: AgentId, policy: UnifiedPolicy): Promise<{ policyId: string }> {
    const native: OpenfortOnchainPolicy = compile(policy, "onchain-policy");
    // TODO(creds): register the session key + on-chain scope:
    //   native.canCall    -> KeysManager.setCanCall(keyId, target, selector)   (allowlist)
    //   native.tokenSpend -> KeysManager.setTokenSpend(keyId, token, limit, period=day)
    //   native.session    -> sessions.create({ validAfter, validUntil }) + owner signs
    //   native.unsupported (perTxCap, denylist, approvalThreshold) is enforced by Cosign.
    void native;
    throw new NotImplementedError("OpenfortProvider.applyPolicy");
  }

  async freeze(_scope: FreezeScope): Promise<FreezeResult> {
    // TODO(creds): KeysManager.pauseKey(keyId); then verify isKeyActive(keyId) === false.
    //   Return { confirmed:false } if the on-chain state can't be confirmed.
    throw new NotImplementedError("OpenfortProvider.freeze");
  }

  async unfreeze(_scope: FreezeScope): Promise<void> {
    // TODO(creds): KeysManager.unpauseKey(keyId).
    throw new NotImplementedError("OpenfortProvider.unfreeze");
  }

  async revokeSession(_agentId: AgentId): Promise<void> {
    // TODO(creds): KeysManager.revokeKey(keyId) — the hard, irreversible kill.
    throw new NotImplementedError("OpenfortProvider.revokeSession");
  }

  subscribe(_handler: (event: ProviderEvent) => void): Unsubscribe {
    // TODO(creds): subscribe to transaction_intent webhooks + poll the Events API.
    return () => {};
  }

  async health(): Promise<HealthStatus> {
    return { healthy: false, detail: "openfort adapter: skeleton, no credentials configured" };
  }
}
