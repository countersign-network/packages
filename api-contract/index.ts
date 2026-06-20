/**
 * @cosign/api-contract — the SINGLE SOURCE OF TRUTH for the Client<->Core wire interface.
 * The Flutter client is generated from this (openapi.yaml for REST + these types for the ws stream),
 * so the approve / freeze / ledger contract never drifts between Dart and TS.
 *
 * The language boundary (Dart client / TS core) is the trust boundary: a compromised client can
 * still only call these endpoints — it holds no keys and cannot weaken policy or move funds.
 */

import type { EnforcementMode, FreezeReport, LedgerEvent } from "@cosign/core";
import type { UnifiedPolicy } from "@cosign/policy";

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

export interface ApplyPolicyRequest {
  /** Target a single agent, or omit to apply to every agent on every backend. */
  agentId?: string;
  policy: UnifiedPolicy;
}

export interface ApplyPolicyResult {
  applied: { providerId: string; agentId: string; policyId: string }[];
  /** Backends that could not confirm the policy — fail-closed: these are NOT live. */
  failed: { providerId: string; agentId: string; error: string }[];
}

export interface FreezeRequest {
  reason?: string;
}

export type FreezeResponse = FreezeReport;

export interface LedgerRecordDTO {
  index: number;
  prevHash: string;
  payloadHash: string;
  rowHash: string;
  payload: LedgerEvent;
}

export interface LedgerResponse {
  records: LedgerRecordDTO[];
  /** Result of re-verifying the hash chain at read time. */
  verified: boolean;
}

/** Messages the Core pushes to the client over the websocket. */
export type WsServerMessage =
  | { type: "hello"; providers: ProviderHealth[] }
  | { type: "ledger_append"; record: LedgerRecordDTO }
  | { type: "freeze_report"; report: FreezeReport };
