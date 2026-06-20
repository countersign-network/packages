/**
 * The typed native-control shapes the compiler emits, one per EnforcementMode. These mirror the
 * real backends' surfaces (see docs/sdk-research/*) and ARE the input types the corresponding
 * adapter's applyPolicy() will consume once credentials exist.
 *
 * Every shape carries an `unsupported` list: the policy fields that backend CANNOT enforce
 * natively, which Cosign therefore enforces itself. That gap list is the whole point of an
 * aggregation layer — it's the part each single vendor can't see.
 */

export interface UnsupportedNote {
  field: string;
  reason: string;
  /** Who covers the gap. For v1 it's always Cosign's own layer. */
  compensation: "cosign-enforced";
}

/* ---- Coinbase Agentic Wallets: native session caps ---- */
export type CoinbaseCriterion =
  | { type: "ethValue"; ethValue: string; operator: "<=" }
  | { type: "evmAddress"; addresses: string[]; operator: "in" | "not in" }
  | { type: "evmNetwork"; networks: string[]; operator: "in" };

export interface CoinbaseRule {
  action: "accept" | "reject";
  operation: "signEvmTransaction";
  criteria: CoinbaseCriterion[];
}

export interface CoinbaseControls {
  provider: "coinbase";
  /** Spend Permission carries the period/daily cap (allowance + periodInDays). */
  spendPermission: { token: string; allowance: string; periodInDays: number } | null;
  /** Policy engine carries per-tx cap, allow/deny, network. First match wins. */
  policy: { scope: "account"; rules: CoinbaseRule[] } | null;
  freeze: boolean;
  unsupported: UnsupportedNote[];
}

/* ---- Turnkey: policy engine evaluated before signing (CEL) ---- */
export interface TurnkeyPolicyEntry {
  policyName: string;
  effect: "EFFECT_ALLOW" | "EFFECT_DENY";
  condition: string;
  consensus: string | null;
  notes: string;
}

export interface TurnkeyPolicyDoc {
  provider: "turnkey";
  policies: TurnkeyPolicyEntry[];
  freeze: boolean;
  unsupported: UnsupportedNote[];
}

/* ---- Openfort: on-chain session-key policy (KeysManager) ---- */
export interface OpenfortOnchainPolicy {
  provider: "openfort";
  session: { validAfter: number; validUntil: number; txCountLimit: number | null };
  /** setCanCall allowlist — on-chain enforcement is a positive allowlist of targets. */
  canCall: { target: string; selector: string }[];
  /** setTokenSpend per-period spend limit. */
  tokenSpend: { token: string; limit: string; period: "day" } | null;
  freeze: boolean;
  unsupported: UnsupportedNote[];
}

export type NativeControls = CoinbaseControls | TurnkeyPolicyDoc | OpenfortOnchainPolicy;
