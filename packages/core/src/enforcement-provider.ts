/**
 * Cosign Core — EnforcementProvider
 * Location in repo: packages/core/src/enforcement-provider.ts
 *
 * THE KEYSTONE ABSTRACTION.
 *
 * Every wallet backend (Coinbase Agentic Wallets, Turnkey, Openfort, ...) is wrapped
 * in an adapter that implements this interface. The freeze controller, policy compiler,
 * ledger, and API depend ONLY on this interface — never on a vendor SDK directly.
 *
 * Enforcement is NATIVE to each backend (MPC/TEE policy, session caps, or on-chain rules).
 * Cosign's job across all of them is the same four verbs:
 *   1. APPLY a unified policy (each adapter compiles it to the backend's native controls)
 *   2. FREEZE (revoke/zero/flip — a hard stop)
 *   3. (optionally) APPROVE inline, for backends that can gate a signature on approval
 *   4. OBSERVE (stream events into the tamper-evident ledger)
 *
 * FAIL-CLOSED CONTRACT (non-negotiable):
 *   - `freeze()` MUST be idempotent and MUST hard-stop. If an adapter cannot CONFIRM the
 *     stop, it returns `{ confirmed: false }` (or throws). The controller then treats the
 *     agent as STILL DANGEROUS and escalates (alert + retry +, if available, on-chain guard).
 *   - `applyPolicy()` that cannot confirm the new policy is live MUST throw — the caller
 *     responds by freezing, never by assuming the looser/old policy is fine.
 *   - No decision / no backend response => the action does NOT execute. Default deny.
 */

import type { UnifiedPolicy } from "@cosign/policy"; // shared declarative policy schema
import type { ProviderId, AgentId, SessionId, Venue } from "./ids";

/* ------------------------------------------------------------------ */
/* Identifiers (branded to prevent mix-ups across providers)          */
/* The branded types + mint/cast helpers live in ./ids.ts and are     */
/* re-exported from the package index, so @cosign/core exposes them.   */
/* ------------------------------------------------------------------ */

export interface AgentRef {
  provider: ProviderId;
  agentId: AgentId;
  wallet: string; // address or vendor wallet handle
  venue: Venue;
  sessionId?: SessionId;
}

/* ------------------------------------------------------------------ */
/* Capabilities — so the controller knows what each backend can do    */
/* ------------------------------------------------------------------ */

export type EnforcementMode =
  | "native-session-caps" // caps enforced in vendor MPC/TEE; freeze = revoke/zero session (e.g. Coinbase)
  | "pre-sign-policy"     // policy evaluated before each signature; can gate on approval (e.g. Turnkey)
  | "onchain-policy";     // session-key scope enforced on-chain; freeze = revoke key / flip guard (e.g. Openfort)

export interface ProviderCapabilities {
  enforcementMode: EnforcementMode;
  /** True if the backend can hold a signature pending an external approve()/deny() decision. */
  supportsInlineApproval: boolean;
  /** True if a freeze is enforced on-chain (strongest guarantee) vs vendor-side. */
  supportsOnchainGuard: boolean;
  supportsSessionRevocation: boolean;
  /** True if the backend pushes real-time events; false => adapter must poll. */
  realtimeEvents: boolean;
  venues: Venue[];
}

/* ------------------------------------------------------------------ */
/* Actions, decisions, freeze                                          */
/* ------------------------------------------------------------------ */

export interface ActionRequest {
  id: string;
  agentId: AgentId;
  kind: "transfer" | "contract-call" | "x402-payment";
  asset: string;             // e.g. "USDC"
  amount: string;            // base units, as a string — NEVER a JS number for money
  counterparty?: string;
  venue: Venue;
  raw?: unknown;             // vendor-native request, for the ledger
  ts: number;
}

export type Decision =
  | { outcome: "allow"; policyId: string }
  | { outcome: "deny"; policyId: string; reason: string }
  | { outcome: "needs_approval"; policyId: string; approvalToken: string; reason: string };

export type FreezeScope =
  | { kind: "agent"; agentId: AgentId }
  | { kind: "provider-all" }; // freeze EVERY agent on this provider

export interface FreezeResult {
  confirmed: boolean;        // false => controller must escalate; the stop is NOT guaranteed
  frozenAgents: AgentId[];
  mechanism: "session-revoked" | "caps-zeroed" | "onchain-guard" | "policy-deny";
  at: number;
}

/* ------------------------------------------------------------------ */
/* Event stream — every item is appended to the hash-chained ledger    */
/* ------------------------------------------------------------------ */

export type ProviderEvent =
  | { type: "action_requested"; agentId: AgentId; action: ActionRequest; ts: number }
  | { type: "action_allowed"; agentId: AgentId; action: ActionRequest; policyId: string; ts: number }
  | { type: "action_blocked"; agentId: AgentId; action: ActionRequest; policyId: string; reason: string; ts: number }
  | { type: "policy_applied"; agentId: AgentId; policyId: string; ts: number }
  | { type: "needs_approval"; agentId: AgentId; action: ActionRequest; approvalToken: string; reason: string; ts: number }
  | { type: "approval_resolved"; agentId: AgentId; approvalToken: string; decision: "approved" | "denied"; ts: number }
  | { type: "session_revoked"; agentId: AgentId; sessionId?: SessionId; ts: number }
  | { type: "frozen"; scope: FreezeScope; mechanism: FreezeResult["mechanism"]; ts: number }
  | { type: "unfrozen"; scope: FreezeScope; ts: number }
  | { type: "error"; agentId?: AgentId; message: string; ts: number };

export type Unsubscribe = () => void;

export interface HealthStatus {
  healthy: boolean;
  latencyMs?: number;
  detail?: string;
}

/* ------------------------------------------------------------------ */
/* The interface                                                       */
/* ------------------------------------------------------------------ */

export interface EnforcementProvider {
  readonly id: ProviderId;

  /** Static-ish description of what this backend can enforce. Probe-able (may hit the vendor). */
  capabilities(): Promise<ProviderCapabilities>;

  /** Create/attach an agent wallet on a given venue. */
  provisionWallet(agentId: AgentId, opts: { venue: Venue }): Promise<AgentRef>;

  /**
   * Compile the unified policy to this backend's native controls and apply it.
   * MUST throw if it cannot confirm the new policy is live (caller will freeze).
   */
  applyPolicy(agentId: AgentId, policy: UnifiedPolicy): Promise<{ policyId: string }>;

  /**
   * OPTIONAL — only meaningful when capabilities.supportsInlineApproval is true.
   * For "native-session-caps" backends, enforcement is autonomous and this is unused;
   * the agent simply cannot exceed the caps, and breaches surface as `action_blocked` events.
   */
  evaluate?(action: ActionRequest): Promise<Decision>;
  approve?(approvalToken: string): Promise<void>;
  deny?(approvalToken: string, reason?: string): Promise<void>;

  /**
   * Hard stop. Idempotent. Fail-closed: if the stop cannot be CONFIRMED, return
   * { confirmed: false } (or throw) so the controller escalates. Never silently succeed.
   */
  freeze(scope: FreezeScope): Promise<FreezeResult>;
  unfreeze(scope: FreezeScope): Promise<void>;

  revokeSession(agentId: AgentId): Promise<void>;

  /** Real-time (or polled) stream of actions/decisions/freezes — feeds the ledger. */
  subscribe(handler: (event: ProviderEvent) => void): Unsubscribe;

  health(): Promise<HealthStatus>;
}

/* ------------------------------------------------------------------ */
/* How the controller uses it (reference — not part of the interface)  */
/* ------------------------------------------------------------------ */
//
// async function freezeEverywhere(providers: EnforcementProvider[]): Promise<void> {
//   const results = await Promise.allSettled(
//     providers.map((p) => p.freeze({ kind: "provider-all" }))
//   );
//   const unconfirmed = results.filter(
//     (r) => r.status === "rejected" || (r.status === "fulfilled" && !r.value.confirmed)
//   );
//   if (unconfirmed.length > 0) {
//     // FAIL-CLOSED: do NOT report "all frozen". Escalate: alert, retry, flip on-chain
//     // guards where available, and surface these agents as STILL DANGEROUS in the ledger + UI.
//     escalate(unconfirmed);
//   }
// }
