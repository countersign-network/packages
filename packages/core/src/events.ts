/**
 * The canonical Countersign event vocabulary. EVERY one of these is appended, in order, to the
 * hash-chained ledger — the audit artifact and source of truth (prime directive #5).
 *
 * Two origins:
 *  - provider-origin events (mirror the adapter's ProviderEvent): what each backend did.
 *  - controller-origin events: the cross-vendor freeze orchestration (the moat made auditable).
 *
 * The ledger package stores these generically (payload-agnostic, hash-chained). Core owns the
 * vocabulary; the ledger owns durability. That split keeps core free of any storage dependency.
 */

import type { ActionRequest, EnforcementMode, FreezeResult, ProviderEvent } from "./enforcement-provider";
import type { AgentId, ProviderId, SessionId } from "./ids";

export type FreezeMechanism = FreezeResult["mechanism"];

/** Per-provider outcome of a freeze attempt. unconfirmed AND failed are BOTH "still dangerous". */
export type FreezeOutcome = "confirmed" | "unconfirmed" | "failed";

export type LedgerEvent =
  // ---- provider-origin (what a backend reported) ----
  | { kind: "action_requested"; providerId: ProviderId; agentId: AgentId; action: ActionRequest; ts: number }
  | { kind: "action_allowed"; providerId: ProviderId; agentId: AgentId; action: ActionRequest; policyId: string; ts: number }
  | { kind: "action_blocked"; providerId: ProviderId; agentId: AgentId; action: ActionRequest; policyId: string; reason: string; ts: number }
  | { kind: "policy_applied"; providerId: ProviderId; agentId: AgentId; policyId: string; ts: number }
  | { kind: "session_revoked"; providerId: ProviderId; agentId: AgentId; sessionId?: SessionId | undefined; ts: number }
  | { kind: "needs_approval"; providerId: ProviderId; agentId: AgentId; action: ActionRequest; approvalToken: string; reason: string; ts: number }
  | { kind: "approval_resolved"; providerId: ProviderId; agentId: AgentId; approvalToken: string; decision: "approved" | "denied"; ts: number }
  // ---- controller-origin (cross-vendor freeze orchestration) ----
  | { kind: "freeze_requested"; freezeId: string; targets: ProviderId[]; reason: string; ts: number }
  | {
      kind: "freeze_result";
      freezeId: string;
      providerId: ProviderId;
      mode: EnforcementMode;
      outcome: FreezeOutcome;
      mechanism?: FreezeMechanism | undefined;
      latencyMs: number;
      detail?: string | undefined;
      ts: number;
    }
  | { kind: "freeze_partial"; freezeId: string; confirmed: ProviderId[]; dangerous: ProviderId[]; ts: number }
  | {
      kind: "escalation_revoke_session";
      freezeId: string;
      providerId: ProviderId;
      agentId: AgentId;
      outcome: "confirmed" | "failed";
      latencyMs: number;
      ts: number;
    }
  | { kind: "freeze_resolved"; freezeId: string; providerCount: number; windowMs: number; ts: number }
  | {
      kind: "still_dangerous";
      freezeId: string;
      dangerous: { providerId: ProviderId; agentId?: AgentId | undefined }[];
      windowMs: number;
      ts: number;
    }
  // ---- anomaly monitor (heuristic circuit breakers) ----
  | {
      kind: "anomaly_detected";
      agentId: AgentId;
      providerId?: ProviderId | undefined;
      rule: "velocity" | "blocked_burst" | "new_counterparty" | "cumulative";
      detail: string;
      action: "alert" | "freeze";
      ts: number;
    }
  | { kind: "error"; providerId?: ProviderId | undefined; agentId?: AgentId | undefined; message: string; ts: number }
  // ---- operational provenance (a backend brought under the control plane) ----
  // `source` distinguishes the seeded demo fleet from an operator's tap-to-connect, so the moat
  // funnel (operator-initiated second-backend rate) stays measurable even when a tenant boots
  // pre-seeded. Absent = operator-initiated (the original, pre-provenance behavior).
  | { kind: "backend_connected"; providerId: ProviderId; ts: number; source?: "seeded" | "operator" | undefined }
  // ---- the countersignature: the ledger head published to an external trust domain (e.g. on-chain) ----
  | { kind: "ledger_anchored"; index: number; rowHash: string; ref?: string | undefined; ts: number };

export type LedgerEventKind = LedgerEvent["kind"];

/** A sink the freeze controller writes to. The ledger package implements this. */
export interface LedgerSink {
  append(event: LedgerEvent): Promise<unknown> | unknown;
}

/**
 * Map a backend's ProviderEvent to the unified ledger vocabulary, stamping the providerId the
 * adapter omits (it knows its own id; the event doesn't carry it). Returns null for events the
 * controller already records itself (frozen/unfrozen), to avoid double-logging.
 */
export function providerEventToLedger(providerId: ProviderId, ev: ProviderEvent): LedgerEvent | null {
  switch (ev.type) {
    case "action_requested":
      return { kind: "action_requested", providerId, agentId: ev.agentId, action: ev.action, ts: ev.ts };
    case "action_allowed":
      return { kind: "action_allowed", providerId, agentId: ev.agentId, action: ev.action, policyId: ev.policyId, ts: ev.ts };
    case "action_blocked":
      return { kind: "action_blocked", providerId, agentId: ev.agentId, action: ev.action, policyId: ev.policyId, reason: ev.reason, ts: ev.ts };
    case "policy_applied":
      return { kind: "policy_applied", providerId, agentId: ev.agentId, policyId: ev.policyId, ts: ev.ts };
    case "needs_approval":
      return { kind: "needs_approval", providerId, agentId: ev.agentId, action: ev.action, approvalToken: ev.approvalToken, reason: ev.reason, ts: ev.ts };
    case "approval_resolved":
      return { kind: "approval_resolved", providerId, agentId: ev.agentId, approvalToken: ev.approvalToken, decision: ev.decision, ts: ev.ts };
    case "session_revoked":
      return { kind: "session_revoked", providerId, agentId: ev.agentId, sessionId: ev.sessionId, ts: ev.ts };
    case "error":
      return { kind: "error", providerId, agentId: ev.agentId, message: ev.message, ts: ev.ts };
    case "frozen":
    case "unfrozen":
      return null; // freeze orchestration is recorded by the FreezeController
    default:
      return null;
  }
}
