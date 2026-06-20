/**
 * The policy compiler — Cosign's core IP. One declarative UnifiedPolicy lowered to each backend's
 * native controls, with an explicit list of what each backend CANNOT enforce natively (so Cosign
 * knows what it must enforce itself). The three lowerings reflect the verified SDK surfaces:
 *   - native-session-caps (Coinbase): Spend Permission (daily cap) + Policy engine (per-tx, allow/deny, net)
 *   - pre-sign-policy (Turnkey): CEL policies evaluated in-enclave; consensus = native approval gate
 *   - onchain-policy (Openfort): KeysManager setCanCall (allowlist) + setTokenSpend (period cap)
 */

import type { EnforcementMode } from "@cosign/core";
import type { UnifiedPolicy } from "./schema";
import { chainIdFor } from "./venues";
import type {
  CoinbaseControls,
  CoinbaseRule,
  CoinbaseCriterion,
  NativeControls,
  OpenfortOnchainPolicy,
  TurnkeyPolicyDoc,
  TurnkeyPolicyEntry,
  UnsupportedNote,
} from "./native";

const SESSION_VALID_DAYS = 30;
const HUMAN_APPROVER_PLACEHOLDER = "<HUMAN_APPROVER_USER_ID>";

// Overloads: a literal mode yields its precise native shape (so adapters get exact types).
export function compile(policy: UnifiedPolicy, mode: "native-session-caps"): CoinbaseControls;
export function compile(policy: UnifiedPolicy, mode: "pre-sign-policy"): TurnkeyPolicyDoc;
export function compile(policy: UnifiedPolicy, mode: "onchain-policy"): OpenfortOnchainPolicy;
export function compile(policy: UnifiedPolicy, mode: EnforcementMode): NativeControls;
export function compile(policy: UnifiedPolicy, mode: EnforcementMode): NativeControls {
  switch (mode) {
    case "native-session-caps":
      return compileCoinbase(policy);
    case "pre-sign-policy":
      return compileTurnkey(policy);
    case "onchain-policy":
      return compileOpenfort(policy);
    default: {
      const _exhaustive: never = mode;
      throw new Error(`unknown enforcement mode: ${String(_exhaustive)}`);
    }
  }
}

/* ------------------------------------------------------------------ */
/* Coinbase — native-session-caps                                      */
/* ------------------------------------------------------------------ */
function compileCoinbase(policy: UnifiedPolicy): CoinbaseControls {
  const unsupported: UnsupportedNote[] = [];
  const rules: CoinbaseRule[] = [];

  // Denylist -> a reject rule that wins before the accept rule (first match wins).
  if (policy.denylist && policy.denylist.length > 0) {
    rules.push({
      action: "reject",
      operation: "signEvmTransaction",
      criteria: [{ type: "evmAddress", addresses: policy.denylist, operator: "in" }],
    });
  }

  // Empty allowlist == deny-all: a criteria-less reject rule matches everything.
  if (policy.allowlist && policy.allowlist.length === 0) {
    rules.push({ action: "reject", operation: "signEvmTransaction", criteria: [] });
  } else {
    const criteria: CoinbaseCriterion[] = [];
    if (policy.perTxCap) criteria.push({ type: "ethValue", ethValue: policy.perTxCap, operator: "<=" });
    if (policy.allowlist && policy.allowlist.length > 0) {
      criteria.push({ type: "evmAddress", addresses: policy.allowlist, operator: "in" });
    }
    if (policy.venues && policy.venues.length > 0) {
      criteria.push({ type: "evmNetwork", networks: policy.venues, operator: "in" });
    }
    rules.push({ action: "accept", operation: "signEvmTransaction", criteria });
  }

  // approvalThreshold has no native inline-approval gate on caps-only backends.
  if (policy.approvalThreshold) {
    unsupported.push({
      field: "approvalThreshold",
      reason: "native-session-caps backends enforce caps autonomously; no inline human approval",
      compensation: "cosign-enforced",
    });
  }

  return {
    provider: "coinbase",
    spendPermission: policy.dailyCap
      ? { token: policy.asset, allowance: policy.dailyCap, periodInDays: 1 }
      : null,
    policy: rules.length > 0 ? { scope: "account", rules } : null,
    freeze: policy.frozen === true,
    unsupported,
  };
}

/* ------------------------------------------------------------------ */
/* Turnkey — pre-sign-policy (CEL, evaluated before signing)           */
/* ------------------------------------------------------------------ */
function compileTurnkey(policy: UnifiedPolicy): TurnkeyPolicyDoc {
  const unsupported: UnsupportedNote[] = [];
  const policies: TurnkeyPolicyEntry[] = [];

  if (policy.frozen) {
    policies.push({
      policyName: "frozen-deny-all",
      effect: "EFFECT_DENY",
      condition: "true",
      consensus: null,
      notes: "policy frozen — deny every signature",
    });
  }

  // Denylist: explicit DENY wins over any allow (Turnkey: any matching DENY wins).
  if (policy.denylist && policy.denylist.length > 0) {
    policies.push({
      policyName: "denylist",
      effect: "EFFECT_DENY",
      condition: `eth.tx.to in [${policy.denylist.map(q).join(", ")}]`,
      consensus: null,
      notes: "blocked counterparties",
    });
  }

  // approvalThreshold -> a consensus policy: above the threshold a human must co-approve. This is
  // Turnkey's NATIVE pre-sign approval gate (activity returns CONSENSUS_NEEDED, no signature yet).
  if (policy.approvalThreshold) {
    policies.push({
      policyName: "approval-threshold",
      effect: "EFFECT_ALLOW",
      condition: `eth.tx.value > ${policy.approvalThreshold}`,
      consensus: `approvers.any(u, u.id == ${q(HUMAN_APPROVER_PLACEHOLDER)})`,
      notes: "spends above threshold require human co-approval",
    });
  }

  // The main allow policy (per-tx cap + allowlist + venue).
  if (policy.allowlist && policy.allowlist.length === 0) {
    // Deny-all: emit no ALLOW; implicit deny covers it. Record the intent for clarity.
    policies.push({
      policyName: "empty-allowlist-deny-all",
      effect: "EFFECT_DENY",
      condition: "true",
      consensus: null,
      notes: "empty allowlist => allow no one",
    });
  } else {
    const conds: string[] = [];
    if (policy.perTxCap) conds.push(`eth.tx.value <= ${policy.perTxCap}`);
    if (policy.allowlist && policy.allowlist.length > 0) {
      conds.push(`eth.tx.to in [${policy.allowlist.map(q).join(", ")}]`);
    }
    if (policy.venues && policy.venues.length > 0) {
      const ids = policy.venues.map(chainIdFor).filter((x): x is number => x !== undefined);
      if (ids.length > 0) conds.push(`eth.tx.chain_id in [${ids.join(", ")}]`);
    }
    policies.push({
      policyName: "agent-spend-allow",
      effect: "EFFECT_ALLOW",
      condition: conds.length > 0 ? conds.join(" && ") : "true",
      consensus: null,
      notes: "per-tx cap + allowlist + venue",
    });
  }

  // Turnkey CEL is per-transaction and STATELESS — it cannot track a rolling daily total.
  if (policy.dailyCap) {
    unsupported.push({
      field: "dailyCap",
      reason: "Turnkey policy conditions are per-tx and stateless; rolling daily totals need external tracking",
      compensation: "cosign-enforced",
    });
  }

  return { provider: "turnkey", policies, freeze: policy.frozen === true, unsupported };
}

/* ------------------------------------------------------------------ */
/* Openfort — onchain-policy (KeysManager session-key scope)           */
/* ------------------------------------------------------------------ */
function compileOpenfort(policy: UnifiedPolicy): OpenfortOnchainPolicy {
  const unsupported: UnsupportedNote[] = [];

  // On-chain enforcement is a POSITIVE allowlist (setCanCall). Absent allowlist can't be expressed
  // safely on-chain; an empty allowlist is a clean deny-all (no permitted targets).
  let canCall: { target: string; selector: string }[] = [];
  if (policy.allowlist) {
    canCall = policy.allowlist.map((target) => ({ target, selector: "*" }));
  } else {
    unsupported.push({
      field: "allowlist",
      reason: "on-chain session keys require an explicit target allowlist; 'any counterparty' is not expressible",
      compensation: "cosign-enforced",
    });
  }

  // KeysManager has tx-count quota + per-period token spend, but no per-tx value cap.
  if (policy.perTxCap) {
    unsupported.push({
      field: "perTxCap",
      reason: "KeysManager enforces per-period spend + tx-count, not a per-transaction value cap",
      compensation: "cosign-enforced",
    });
  }

  // Denylist isn't expressible against a positive on-chain allowlist.
  if (policy.denylist && policy.denylist.length > 0) {
    unsupported.push({
      field: "denylist",
      reason: "on-chain enforcement is a positive allowlist; a denylist has no native counterpart",
      compensation: "cosign-enforced",
    });
  }

  // No inline human-approval gate exists on-chain.
  if (policy.approvalThreshold) {
    unsupported.push({
      field: "approvalThreshold",
      reason: "on-chain session keys cannot hold a signature pending human approval",
      compensation: "cosign-enforced",
    });
  }

  return {
    provider: "openfort",
    session: { validAfter: 0, validUntil: SESSION_VALID_DAYS, txCountLimit: null },
    canCall,
    tokenSpend: policy.dailyCap ? { token: policy.asset, limit: policy.dailyCap, period: "day" } : null,
    freeze: policy.frozen === true,
    unsupported,
  };
}

/** Quote a string for embedding in a CEL condition. */
function q(s: string): string {
  return `'${s.replace(/'/g, "\\'")}'`;
}
