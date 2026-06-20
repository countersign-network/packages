/**
 * Turnkey adapter — SKELETON. EnforcementMode = pre-sign-policy (policy engine evaluated in the
 * enclave BEFORE signing; consensus = native human-approval gate).
 *
 * To finish: `pnpm add @turnkey/sdk-server @turnkey/ethers` and fill the TODOs per
 * docs/sdk-research/turnkey.md. Keys never leave the TEE; the agent gets signatures, never keys.
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
import { compile, type TurnkeyPolicyDoc, type UnifiedPolicy } from "@cosign/policy";

export interface TurnkeyConfig {
  apiPublicKey?: string;
  apiPrivateKey?: string;
  organizationId?: string;
}

export class TurnkeyProvider implements EnforcementProvider {
  readonly id = asProviderId("turnkey");
  constructor(private readonly config: TurnkeyConfig = {}) {}

  async capabilities(): Promise<ProviderCapabilities> {
    return {
      enforcementMode: "pre-sign-policy",
      supportsInlineApproval: true, // consensus policy => ACTIVITY_STATUS_CONSENSUS_NEEDED
      supportsOnchainGuard: false, // Turnkey only signs; chains are external
      supportsSessionRevocation: true, // deleteApiKeys / deleteUsers
      realtimeEvents: true, // webhooks: ACTIVITY_UPDATES (Ed25519-signed)
      venues: ["ethereum-sepolia", "base-sepolia", "polygon-amoy"],
    };
  }

  async provisionWallet(_agentId: AgentId, _opts: { venue: Venue }): Promise<AgentRef> {
    // TODO(creds): createSubOrganization({ rootUsers:[agent P-256 key], wallet:{ accounts:[...] } }).
    throw new NotImplementedError("TurnkeyProvider.provisionWallet");
  }

  async applyPolicy(_agentId: AgentId, policy: UnifiedPolicy): Promise<{ policyId: string }> {
    const native: TurnkeyPolicyDoc = compile(policy, "pre-sign-policy");
    // TODO(creds): for each native.policies[] -> apiClient.createPolicy({ effect, condition, consensus }).
    //   native.unsupported (e.g. dailyCap — CEL is stateless) is tracked app-side by Cosign.
    void native;
    throw new NotImplementedError("TurnkeyProvider.applyPolicy");
  }

  async evaluate(_action: ActionRequest): Promise<Decision> {
    // TODO(creds): submit the signing activity; map ALLOW/DENY/CONSENSUS_NEEDED to the Decision.
    throw new NotImplementedError("TurnkeyProvider.evaluate");
  }

  async approve(_approvalToken: string): Promise<void> {
    // TODO(creds): approve the pending activity by its `fingerprint`.
    throw new NotImplementedError("TurnkeyProvider.approve");
  }

  async deny(_approvalToken: string, _reason?: string): Promise<void> {
    throw new NotImplementedError("TurnkeyProvider.deny");
  }

  async freeze(_scope: FreezeScope): Promise<FreezeResult> {
    // TODO(creds): deleteApiKeys (fastest) or createPolicy EFFECT_DENY. Confirm before returning.
    throw new NotImplementedError("TurnkeyProvider.freeze");
  }

  async unfreeze(_scope: FreezeScope): Promise<void> {
    throw new NotImplementedError("TurnkeyProvider.unfreeze");
  }

  async revokeSession(_agentId: AgentId): Promise<void> {
    // TODO(creds): deleteApiKeys / deleteUsers for the agent.
    throw new NotImplementedError("TurnkeyProvider.revokeSession");
  }

  subscribe(_handler: (event: ProviderEvent) => void): Unsubscribe {
    // TODO(creds): createWebhookEndpoint({ ACTIVITY_UPDATES }); verify X-Turnkey-Signature (ed25519).
    return () => {};
  }

  async health(): Promise<HealthStatus> {
    return { healthy: false, detail: "turnkey adapter: skeleton, no credentials configured" };
  }
}
