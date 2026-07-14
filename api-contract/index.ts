/**
 * @countersign/api-contract — the SINGLE SOURCE OF TRUTH for the Client<->Core wire interface.
 * The Flutter client is generated from this (openapi.yaml for REST + these types for the ws stream),
 * so the approve / freeze / ledger contract never drifts between Dart and TS.
 *
 * The language boundary (Dart client / TS core) is the trust boundary: a compromised client can
 * still only call these endpoints — it holds no keys and cannot weaken policy or move funds.
 */

import type { EnforcementMode, FreezeReport, LedgerEvent, UnifiedPolicy, UnifiedPolicyInput } from "@countersign/core";

export const WS_PATH = "/events";

export interface ProviderHealth {
  id: string;
  mode: EnforcementMode;
  healthy: boolean;
  detail?: string;
}

export interface HealthResponse {
  ok: boolean;
  providers: ProviderHealth[];
}

export interface AgentDTO {
  providerId: string;
  agentId: string;
  wallet: string;
  venue: string;
  mode: EnforcementMode;
}

export interface AgentsResponse {
  agents: AgentDTO[];
}

/**
 * Per-rail enforceability (A3). A security control whose binding you can't see isn't one: this surfaces,
 * per provider + policy field, whether the rail enforces it NATIVELY (in vendor MPC/TEE/on-chain) or
 * only at the Countersign pre-flight layer. The freeze itself is native on every current rail; what
 * varies is fine-grained policy. Computed from the compiler's `unsupported[]`.
 */
export interface FieldEnforcement {
  field: string;
  binding: "native" | "countersign-layer";
  /** Why it isn't native (present only for countersign-layer fields). */
  reason?: string;
}

export interface ProviderEnforcement {
  providerId: string;
  mode: EnforcementMode;
  /** Is the FREEZE (kill switch) enforced natively by this rail? True for all current rails. */
  freezeNative: boolean;
  /** Fraction of policy fields bound natively (0..1) — for ranking rails by enforceability. */
  nativeScore: number;
  fields: FieldEnforcement[];
}

export interface EnforcementResponse {
  providers: ProviderEnforcement[];
}

export interface ApplyPolicyRequest {
  /** Target a single agent, or omit to apply to every agent on every backend. */
  agentId?: string;
  /** Either schema generation is accepted; the Core normalizes to canonical v2 on receipt. */
  policy: UnifiedPolicyInput;
}

export interface ApplyPolicyResult {
  applied: { providerId: string; agentId: string; policyId: string }[];
  /** Backends that could not confirm the policy — fail-closed: these are NOT live. */
  failed: { providerId: string; agentId: string; error: string }[];
}

export interface FreezeRequest {
  reason?: string;
  /** Agent-scoped freeze (A6): stop just this agent across its provider(s) instead of the whole fleet. */
  agentId?: string;
}

export interface UnfreezeRequest {
  /** Lift only this agent's scoped freeze (A6); omit to lift the whole-fleet freeze. */
  agentId?: string;
}

export type FreezeResponse = FreezeReport;

/**
 * The agent-facing pre-flight guard: an agent asks Countersign "should I make this spend?" BEFORE it
 * touches the wallet. Countersign answers from the unified policy and records the decision. This is the
 * call that gets made on every transaction — the data flywheel.
 */
export interface EvaluateRequest {
  agentId: string;
  amount: string; // base units
  asset: string;
  counterparty?: string;
  venue: string;
  /** Marketplace listing being paid (x402 Bazaar / Agentic.Market pin), when known. */
  listingId?: string;
}

export interface EvaluateResponse {
  outcome: "allow" | "deny" | "needs_approval";
  reason?: string;
  approvalToken?: string;
  policyId: string;
}

/** A spend held pending human approval (the Turnkey-style consensus path). */
export interface PendingApprovalDTO {
  approvalToken: string;
  agentId: string;
  providerId: string;
  amount: string;
  asset: string;
  counterparty?: string;
  venue: string;
  reason: string;
  ts: number;
}

export interface ApprovalsResponse {
  approvals: PendingApprovalDTO[];
}

export interface ApproveRequest {
  approvalToken: string;
}

export interface DenyRequest {
  approvalToken: string;
  reason?: string;
}

export interface ApprovalResolution {
  outcome: "approved" | "denied";
  agentId: string;
  approvalToken: string;
  reason?: string;
}

export interface LedgerRecordDTO {
  index: number;
  prevHash: string;
  payloadHash: string;
  rowHash: string;
  payload: LedgerEvent;
}

export interface LedgerResponse {
  records: LedgerRecordDTO[];
  /** Result of re-verifying the hash chain (and signatures, if signed) at read time. */
  verified: boolean;
  /** Ed25519 public key (base64 SPKI) to independently verify the signed ledger, if signed. */
  publicKey?: string;
}

/** Messages the Core pushes to the client over the websocket. */
export type WsServerMessage =
  | { type: "hello"; providers: ProviderHealth[] }
  | { type: "ledger_append"; record: LedgerRecordDTO }
  | { type: "freeze_report"; report: FreezeReport };

/**
 * The operations the front door exposes — the single abstraction the SDK client, the embedded
 * in-process Core, the MCP tools, and the x402 guard all program against. `CountersignClient` (HTTP) and
 * the local adapter both implement this, so callers don't care whether the Core is remote or embedded.
 */
export interface CountersignApi {
  health(): Promise<HealthResponse>;
  agents(): Promise<AgentsResponse>;
  /** Per-rail enforceability matrix (A3): which policy fields each backend binds natively vs at the layer. */
  enforcement(): Promise<EnforcementResponse>;
  applyPolicy(req: ApplyPolicyRequest): Promise<ApplyPolicyResult>;
  evaluate(req: EvaluateRequest): Promise<EvaluateResponse>;
  approvals(): Promise<ApprovalsResponse>;
  approve(req: ApproveRequest): Promise<ApprovalResolution>;
  deny(req: DenyRequest): Promise<ApprovalResolution>;
  freeze(req?: FreezeRequest): Promise<FreezeResponse>;
  unfreeze(req?: UnfreezeRequest): Promise<{ ok: boolean }>;
  ledger(): Promise<LedgerResponse>;
}
