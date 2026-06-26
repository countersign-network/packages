/**
 * Turnkey adapter — LIVE (testnet-safe). EnforcementMode = pre-sign-policy: a CEL policy is
 * evaluated INSIDE Turnkey's enclave before any signature, so it cannot be bypassed from app code.
 *
 * What's real here (verified against @turnkey/sdk-server v6.1.1):
 *  - provisionWallet  -> createSubOrganization (we are the admin root user) + createUsers (the agent
 *                        as a NON-root delegated user with its own P-256 key) + an inline EVM wallet.
 *  - applyPolicy      -> compile the unified policy to Turnkey CEL and createPolicy into the sub-org.
 *                        Turnkey policies only bind NON-root users — which is exactly why the agent is
 *                        delegated, not root: the cap/allowlist actually gate it.
 *  - freeze           -> createPolicy EFFECT_DENY (deny wins over allow) — a confirmed, reversible
 *                        kill. revokeSession escalates to deleteUsers (the hard, irreversible kill).
 *
 * Turnkey is chain-agnostic: it only signs. Testnet safety (directive #6) is ours — we scope policies
 * by testnet chain_id and broadcast to a testnet RPC. Single endpoint https://api.turnkey.com (no
 * separate testnet host). Keys never leave the TEE; the agent gets signatures, never the key.
 *
 * Re-verify SDK shapes in docs/sdk-research/turnkey.md before changing live calls.
 */

import { Turnkey, type TurnkeyApiClient } from "@turnkey/sdk-server";
import { generateP256KeyPair } from "@turnkey/crypto";
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
} from "@cosign/core";
import { compile, type TurnkeyPolicyDoc, type UnifiedPolicy } from "@cosign/policy";

const TURNKEY_API_BASE_URL = "https://api.turnkey.com";
const HUMAN_APPROVER_PLACEHOLDER = "<HUMAN_APPROVER_USER_ID>";

export interface TurnkeyConfig {
  apiPublicKey?: string;
  apiPrivateKey?: string;
  organizationId?: string;
  apiBaseUrl?: string;
}

/** Everything we provision per agent, so we can later policy/freeze/revoke it. */
interface TurnkeyAgent {
  subOrgId: string;
  walletAddress: string;
  /** The agent's delegated (non-root) user id — what policies target and what we delete to revoke. */
  agentUserId: string;
  /** The agent's session keypair (P-256). The private key is held only to sign spends later. */
  agentKey: { publicKey: string; privateKey: string };
  /** The applied unified-policy id (Cosign-side handle). */
  policyId?: string;
  /** Turnkey policy ids created for this agent (so we can clean up / unfreeze). */
  turnkeyPolicyIds: string[];
  /** The EFFECT_DENY policy id installed by freeze() (so unfreeze can deletePolicy it). */
  freezePolicyId?: string;
}

export class TurnkeyProvider implements EnforcementProvider {
  readonly id = asProviderId("turnkey");

  private turnkey: Turnkey | undefined;
  private readonly agents = new Map<AgentId, TurnkeyAgent>();
  private readonly handlers = new Set<(e: ProviderEvent) => void>();
  private providerFrozen = false;

  constructor(private readonly config: TurnkeyConfig = {}) {}

  /** Lazy — so the provider can be constructed (and capabilities() read) without credentials. */
  private client(): TurnkeyApiClient {
    if (!this.turnkey) {
      const organizationId = this.config.organizationId ?? process.env["TURNKEY_ORGANIZATION_ID"];
      const apiPrivateKey = this.config.apiPrivateKey ?? process.env["TURNKEY_API_PRIVATE_KEY"];
      const apiPublicKey = this.config.apiPublicKey ?? process.env["TURNKEY_API_PUBLIC_KEY"];
      if (!organizationId || !apiPrivateKey || !apiPublicKey) {
        throw new Error(
          "turnkey: missing credentials (TURNKEY_ORGANIZATION_ID / TURNKEY_API_PRIVATE_KEY / TURNKEY_API_PUBLIC_KEY)",
        );
      }
      this.turnkey = new Turnkey({
        defaultOrganizationId: organizationId,
        apiBaseUrl: this.config.apiBaseUrl ?? process.env["TURNKEY_API_BASE_URL"] ?? TURNKEY_API_BASE_URL,
        apiPrivateKey,
        apiPublicKey,
      });
    }
    return this.turnkey.apiClient();
  }

  private rootApiPublicKey(): string {
    const k = this.config.apiPublicKey ?? process.env["TURNKEY_API_PUBLIC_KEY"];
    if (!k) throw new Error("turnkey: TURNKEY_API_PUBLIC_KEY missing");
    return k;
  }

  async capabilities(): Promise<ProviderCapabilities> {
    return {
      enforcementMode: "pre-sign-policy", // CEL policy evaluated in-enclave before each signature
      supportsInlineApproval: false, // Turnkey supports consensus gating; wiring it is phase-2
      supportsOnchainGuard: false, // Turnkey only signs; chains are external
      supportsSessionRevocation: true, // deleteUsers / deleteApiKeys
      realtimeEvents: false, // webhooks (ACTIVITY_UPDATES) not wired yet; adapter mediates synchronously
      venues: ["ethereum-sepolia", "base-sepolia", "polygon-amoy"],
    };
  }

  /**
   * Provision an agent: a sub-organization with an EVM wallet, with US as the admin root user and the
   * agent as a NON-root delegated user holding its own P-256 session key. Non-root is deliberate —
   * Turnkey root users bypass policies, so a delegated user is what makes the cap/allowlist (and the
   * freeze deny) actually enforceable.
   */
  async provisionWallet(agentId: AgentId, opts: { venue: Venue }): Promise<AgentRef> {
    const client = this.client();
    const agentKey = generateP256KeyPair();

    // 1) Sub-org + inline EVM wallet. Root user = us (the parent API key) so we retain management.
    const subOrg = await client.createSubOrganization({
      subOrganizationName: `cosign-${String(agentId)}-${nextId("so")}`,
      rootUsers: [
        {
          userName: "cosign-admin",
          apiKeys: [
            { apiKeyName: "cosign-root", publicKey: this.rootApiPublicKey(), curveType: "API_KEY_CURVE_P256" },
          ],
          authenticators: [],
          oauthProviders: [],
        },
      ],
      rootQuorumThreshold: 1,
      wallet: {
        walletName: `${String(agentId)}-wallet`,
        accounts: [
          {
            curve: "CURVE_SECP256K1",
            pathFormat: "PATH_FORMAT_BIP32",
            path: "m/44'/60'/0'/0/0",
            addressFormat: "ADDRESS_FORMAT_ETHEREUM",
          },
        ],
      },
    });
    const subOrgId = subOrg.subOrganizationId;
    const walletAddress = subOrg.wallet?.addresses?.[0];
    if (!subOrgId || !walletAddress) {
      throw new Error("turnkey: createSubOrganization returned no sub-org id / wallet address");
    }

    // 2) The agent as a NON-root delegated user (zero permissions until a policy grants them).
    const created = await client.createUsers({
      organizationId: subOrgId,
      users: [
        {
          userName: "agent",
          apiKeys: [
            { apiKeyName: "agent-session", publicKey: agentKey.publicKey, curveType: "API_KEY_CURVE_P256" },
          ],
          authenticators: [],
          oauthProviders: [],
          userTags: [],
        },
      ],
    });
    const agentUserId = created.userIds?.[0];
    if (!agentUserId) throw new Error("turnkey: createUsers returned no user id");

    this.agents.set(agentId, {
      subOrgId,
      walletAddress,
      agentUserId,
      agentKey: { publicKey: agentKey.publicKey, privateKey: agentKey.privateKey },
      turnkeyPolicyIds: [],
    });
    return { provider: this.id, agentId, wallet: walletAddress, venue: opts.venue };
  }

  /**
   * Compile the unified policy to Turnkey CEL and install each clause in the agent's sub-org. The
   * agent-spend-allow clause is scoped to the agent (consensus = the agent user), so only the agent's
   * own in-cap, in-allowlist transactions are permitted; everything else falls to Turnkey's implicit
   * deny. Per the fail-closed contract, this THROWS if it cannot confirm at least one binding clause.
   */
  async applyPolicy(agentId: AgentId, policy: UnifiedPolicy): Promise<{ policyId: string }> {
    const a = this.require(agentId);
    const client = this.client();
    const native: TurnkeyPolicyDoc = compile(policy, "pre-sign-policy");

    let boundClauses = 0;
    const cosignTracked: string[] = [...native.unsupported.map((u) => u.field)];
    for (const entry of native.policies) {
      // Never silently weaken (invariant #5): a clause that needs a human approver we don't have
      // configured is NOT pushed loosened — it's tracked as Cosign-enforced instead.
      if (entry.consensus && entry.consensus.includes(HUMAN_APPROVER_PLACEHOLDER)) {
        cosignTracked.push(entry.policyName);
        continue;
      }
      // condition gates WHEN; consensus (only when the compiler set one) gates WHO must approve.
      const res = await client.createPolicy({
        organizationId: a.subOrgId,
        policyName: `${entry.policyName}-${nextId("p")}`,
        effect: entry.effect,
        condition: entry.condition,
        notes: entry.notes,
        ...(entry.consensus ? { consensus: entry.consensus } : {}),
      });
      if (!res.policyId) throw new Error(`turnkey: createPolicy did not confirm (${entry.policyName})`);
      a.turnkeyPolicyIds.push(res.policyId);
      boundClauses++;
    }

    // Fail-closed: if NOTHING bound natively (and there was something to bind), don't pretend it's live.
    if (boundClauses === 0 && native.policies.some((p) => !p.consensus?.includes(HUMAN_APPROVER_PLACEHOLDER))) {
      throw new Error("turnkey: no native policy clause could be confirmed live");
    }

    const policyId = nextId("pol");
    a.policyId = policyId;
    this.emit({ type: "policy_applied", agentId, policyId, ts: Date.now() });
    if (cosignTracked.length > 0) {
      this.emit({ type: "error", agentId, message: `cosign-tracked (not native): ${cosignTracked.join(", ")}`, ts: Date.now() });
    }
    return { policyId };
  }

  /**
   * Hard stop. Installs an EFFECT_DENY policy (deny wins over any allow) in each target sub-org, so
   * Turnkey refuses to sign for the agent. Fail-closed: confirmed:false if any target can't be denied.
   * Idempotent — re-freezing a frozen agent is a no-op that still reports confirmed.
   */
  async freeze(scope: FreezeScope): Promise<FreezeResult> {
    if (scope.kind === "provider-all") this.providerFrozen = true;
    const targets: AgentId[] = scope.kind === "provider-all" ? [...this.agents.keys()] : [scope.agentId];
    const client = this.client();

    const results = await Promise.allSettled(
      targets.map(async (id) => {
        const a = this.require(id);
        if (a.freezePolicyId) return id; // already frozen — idempotent
        const res = await client.createPolicy({
          organizationId: a.subOrgId,
          policyName: `cosign-freeze-${nextId("f")}`,
          effect: "EFFECT_DENY",
          condition: "true", // matches every signing activity in this agent's sub-org
          notes: "cosign freeze — deny every signature",
        });
        if (!res.policyId) throw new Error(`turnkey: freeze policy not confirmed for ${String(id)}`);
        a.freezePolicyId = res.policyId;
        this.emit({ type: "frozen", scope: { kind: "agent", agentId: id }, mechanism: "policy-deny", ts: Date.now() });
        return id;
      }),
    );

    const frozenAgents: AgentId[] = [];
    let confirmed = true;
    for (const r of results) {
      if (r.status === "fulfilled") frozenAgents.push(r.value);
      else confirmed = false; // a target we could not confirm => still dangerous => escalate
    }
    return { confirmed, frozenAgents, mechanism: "policy-deny", at: Date.now() };
  }

  async unfreeze(scope: FreezeScope): Promise<void> {
    if (scope.kind === "provider-all") this.providerFrozen = false;
    const targets: AgentId[] = scope.kind === "provider-all" ? [...this.agents.keys()] : [scope.agentId];
    const client = this.client();
    for (const id of targets) {
      const a = this.agents.get(id);
      if (!a?.freezePolicyId) continue;
      await client.deletePolicy({ organizationId: a.subOrgId, policyId: a.freezePolicyId });
      delete a.freezePolicyId;
      this.emit({ type: "unfrozen", scope: { kind: "agent", agentId: id }, ts: Date.now() });
    }
  }

  /** The hard, irreversible kill: delete the agent's delegated user — it can never sign again. */
  async revokeSession(agentId: AgentId): Promise<void> {
    const a = this.require(agentId);
    await this.client().deleteUsers({ organizationId: a.subOrgId, userIds: [a.agentUserId] });
    this.emit({ type: "session_revoked", agentId, ts: Date.now() });
  }

  subscribe(handler: (event: ProviderEvent) => void): Unsubscribe {
    // Phase-2: createWebhookEndpoint(ACTIVITY_UPDATES) + verify X-Turnkey-Signature (ed25519).
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  async health(): Promise<HealthStatus> {
    try {
      const t0 = Date.now();
      const who = await this.client().getWhoami({});
      return { healthy: true, latencyMs: Date.now() - t0, detail: `turnkey: live (org ${who.organizationId})` };
    } catch (err) {
      return { healthy: false, detail: `turnkey: ${err instanceof Error ? err.message : String(err)}` };
    }
  }

  /* ---- accessors (for spikes / observability) ---- */

  getAgent(agentId: AgentId): Readonly<TurnkeyAgent> | undefined {
    return this.agents.get(agentId);
  }

  isProviderFrozen(): boolean {
    return this.providerFrozen;
  }

  /* ---- internals ---- */

  private require(agentId: AgentId): TurnkeyAgent {
    const a = this.agents.get(agentId);
    if (!a) throw new Error(`turnkey: agent ${String(agentId)} has no provisioned wallet`);
    return a;
  }

  private emit(event: ProviderEvent): void {
    for (const h of this.handlers) h(event);
  }
}
