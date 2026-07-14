/**
 * The declarative policy CONTRACT — the ONE policy shape an operator writes (caps, allow/deny
 * lists, approval threshold, freeze, venue rules) plus its validators/builders. This is the PUBLIC
 * part of the policy story, so it lives in @countersign/core (the open interface package): the
 * front door can describe and validate a policy WITHOUT the proprietary compiler. The compiler
 * that lowers this shape to each backend's native controls — the IP — lives in @countersign/policy.
 *
 * Two schema generations are accepted on input; the system operates on ONE canonical shape:
 *   v1 (schemaVersion 1): `venues` is a plain allow-array of venue names.
 *   v2 (schemaVersion 2): `venues` is a rules block — allow/deny lists, marketplace listing
 *       allowlist, and per-venue caps (Roadmap v2, Phase 1).
 * `parsePolicy`/`normalizePolicy` migrate v1 → v2 (a v1 venues array IS a v2 allow list), so the
 * evaluator, the compiler, and every consumer see only the canonical v2 shape. v1 stays accepted
 * forever: stored tenant policies and published-SDK callers re-parse on every boot/apply.
 */
import { z } from "zod";

/** A non-negative integer amount in base units (wei, USDC 6-dec smallest unit, ...). */
const amount = z
  .string()
  .regex(/^\d+$/, "amount must be a non-negative integer base-unit string");

// A 0x-prefixed 40-hex EVM address. Strict on purpose: addresses are interpolated into backend-native
// policy controls (e.g. Turnkey CEL conditions), so anything other than hex is both a real-world
// footgun and a policy-injection vector. Validating here is the first line of that defense.
const address = z
  .string()
  .regex(/^0x[0-9a-fA-F]{40}$/, "address must be a 0x-prefixed 40-hex EVM address");

/** A venue name (chain/marketplace identifier, e.g. "base-sepolia") — non-empty, no whitespace. */
const venueName = z
  .string()
  .regex(/^\S+$/, "venue must be a non-empty name with no whitespace");

/** A marketplace listing identifier (x402 Bazaar / Agentic.Market listing ID) — non-empty. */
const listingId = z.string().min(1, "listing id must be non-empty");

/** Per-venue caps: base-unit amounts scoped to spends on ONE venue. */
export const VenueCapsSchema = z.strictObject({
  /** Max value of a single spend on this venue (base units). */
  perTx: amount.optional(),
  /** Max cumulative spend on this venue per rolling day (base units). */
  dailyRolling: amount.optional(),
});
export type VenueCaps = z.infer<typeof VenueCapsSchema>;

/**
 * Venue rules (schema v2): WHERE and ON WHAT an agent may spend.
 * Precedence is fail-closed: `deny` always wins over `allow`; an ABSENT `allow` means any venue
 * (subject to `deny`); a PRESENT-but-EMPTY `allow` denies every venue (parity with the counterparty
 * allowlist sentinel). A PRESENT `listingAllowlist` requires every spend to carry a `listingId` on
 * the list — a spend with no listing id is denied, not waved through.
 */
export const VenueRulesSchema = z.strictObject({
  /** Venues agents may spend on. ABSENT = any venue (subject to deny). EMPTY = deny all. */
  allow: z.array(venueName).optional(),
  /** Venues always denied — wins over `allow`. */
  deny: z.array(venueName).optional(),
  /** Marketplace listing IDs agents may pay. PRESENT = spends must name a listed `listingId`. */
  listingAllowlist: z.array(listingId).optional(),
  /** Per-venue caps, keyed by venue name. */
  perVenueCaps: z.record(venueName, VenueCapsSchema).optional(),
});
export type VenueRules = z.infer<typeof VenueRulesSchema>;

// Fields shared by both schema generations. Kept as a single source so v1/v2 can never drift apart.
const commonFields = {
  /** Asset the caps apply to, e.g. "USDC". */
  asset: z.string().min(1),
  /** Max value of a single spend (base units). Absent = no per-tx cap. */
  perTxCap: amount.optional(),
  /** Max cumulative spend per rolling day (base units). Absent = no daily cap. */
  dailyCap: amount.optional(),
  /**
   * Counterparty allowlist. ABSENT = any counterparty allowed (subject to other rules).
   * PRESENT-but-EMPTY ([]) = deny everything (an explicit "allow nobody" sentinel).
   */
  allowlist: z.array(address).optional(),
  /** Counterparty denylist — always wins over the allowlist. */
  denylist: z.array(address).optional(),
  /** Spends STRICTLY ABOVE this require human approval before signing (base units). */
  approvalThreshold: amount.optional(),
  /** Hard kill — deny everything regardless of the rest. */
  frozen: z.boolean().optional(),
} as const;

/** Schema v1 — `venues` is a plain allow-array. Accepted forever; normalized to v2 on parse. */
export const UnifiedPolicyV1Schema = z.strictObject({
  schemaVersion: z.literal(1),
  ...commonFields,
  /** Allowed venues/chains by name. Absent = any venue. (v2 expresses this as `venues.allow`.) */
  venues: z.array(venueName).optional(),
});
export type UnifiedPolicyV1 = z.infer<typeof UnifiedPolicyV1Schema>;

/** Schema v2 — `venues` is a rules block (allow/deny, listing allowlist, per-venue caps). */
export const UnifiedPolicyV2Schema = z.strictObject({
  schemaVersion: z.literal(2),
  ...commonFields,
  venues: VenueRulesSchema.optional(),
});
export type UnifiedPolicyV2 = z.infer<typeof UnifiedPolicyV2Schema>;

/** What operators may SUBMIT: either schema generation. */
export const UnifiedPolicySchema = z.discriminatedUnion("schemaVersion", [
  UnifiedPolicyV1Schema,
  UnifiedPolicyV2Schema,
]);
/** Either accepted input generation. Use this for API/SDK request types. */
export type UnifiedPolicyInput = z.infer<typeof UnifiedPolicySchema>;

/**
 * The CANONICAL policy shape the system operates on (v2). Everything past the parse boundary —
 * evaluator, compiler, providers, stores — sees only this.
 */
export type UnifiedPolicy = UnifiedPolicyV2;

/** Migrate an accepted input policy to the canonical v2 shape (v1 venues array → `venues.allow`). */
export function normalizePolicy(input: UnifiedPolicyInput): UnifiedPolicy {
  if (input.schemaVersion === 2) return input;
  const { schemaVersion: _v, venues, ...rest } = input;
  return {
    schemaVersion: 2,
    ...rest,
    ...(venues !== undefined ? { venues: { allow: venues } } : {}),
  };
}

/** Validate unknown input (either generation) and return the canonical policy. */
export function parsePolicy(input: unknown): UnifiedPolicy {
  return normalizePolicy(UnifiedPolicySchema.parse(input));
}

type DefineInput =
  | Omit<UnifiedPolicyV1, "schemaVersion">
  | Omit<UnifiedPolicyV2, "schemaVersion">;

/**
 * Convenience builder for code/tests — fills schemaVersion (inferred from the `venues` shape),
 * validates, and returns the canonical policy.
 */
export function definePolicy(input: DefineInput): UnifiedPolicy {
  const schemaVersion = Array.isArray((input as { venues?: unknown }).venues) ? 1 : 2;
  return parsePolicy({ schemaVersion, ...input });
}
