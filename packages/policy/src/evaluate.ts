/**
 * The executable semantics of a UnifiedPolicy. This is the SINGLE SOURCE OF TRUTH for what a
 * policy means; the compiler lowers these same semantics to each backend's native controls, and
 * the MockProvider enforces via this evaluator so "compiled correctly" and "enforced correctly"
 * are checked against one definition.
 *
 * Evaluation order is deliberate and fail-closed:
 *   frozen -> venue -> denylist -> allowlist -> per-tx cap -> daily cap -> approval threshold.
 * Anything not explicitly allowed at the end is allowed ONLY if it passed every gate.
 */

import { cmpAmount, addAmount } from "@countersign/core";
import type { UnifiedPolicy } from "./schema";

export interface SpendAttempt {
  amount: string; // base units
  asset: string;
  counterparty?: string | undefined;
  venue: string;
}

export interface EvalContext {
  /** Cumulative spend of `policy.asset` in the current rolling day, base units. Default "0". */
  dailySpent?: string | undefined;
}

export type EvalResult =
  | { outcome: "allow" }
  | { outcome: "deny"; reason: string }
  | { outcome: "needs_approval"; reason: string };

export function evaluatePolicy(
  policy: UnifiedPolicy,
  attempt: SpendAttempt,
  ctx: EvalContext = {},
): EvalResult {
  if (policy.frozen) {
    return { outcome: "deny", reason: "policy frozen" };
  }

  if (policy.venues && !policy.venues.includes(attempt.venue)) {
    return { outcome: "deny", reason: `venue ${attempt.venue} not permitted` };
  }

  if (policy.denylist && attempt.counterparty && policy.denylist.includes(attempt.counterparty)) {
    return { outcome: "deny", reason: `counterparty ${attempt.counterparty} is denylisted` };
  }

  if (policy.allowlist) {
    if (policy.allowlist.length === 0) {
      return { outcome: "deny", reason: "empty allowlist denies all counterparties" };
    }
    if (!attempt.counterparty || !policy.allowlist.includes(attempt.counterparty)) {
      return { outcome: "deny", reason: `counterparty ${attempt.counterparty ?? "(none)"} not on allowlist` };
    }
  }

  // Caps apply only to the policy's asset. A different asset has no cap configured here.
  const sameAsset = attempt.asset === policy.asset;

  if (sameAsset && policy.perTxCap && cmpAmount(attempt.amount, policy.perTxCap) > 0) {
    return { outcome: "deny", reason: `amount ${attempt.amount} exceeds per-tx cap ${policy.perTxCap}` };
  }

  if (sameAsset && policy.dailyCap) {
    const projected = addAmount(ctx.dailySpent ?? "0", attempt.amount);
    if (cmpAmount(projected, policy.dailyCap) > 0) {
      return { outcome: "deny", reason: `daily total ${projected} would exceed daily cap ${policy.dailyCap}` };
    }
  }

  if (sameAsset && policy.approvalThreshold && cmpAmount(attempt.amount, policy.approvalThreshold) > 0) {
    return { outcome: "needs_approval", reason: `amount ${attempt.amount} above approval threshold ${policy.approvalThreshold}` };
  }

  return { outcome: "allow" };
}
