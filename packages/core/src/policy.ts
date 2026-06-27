/**
 * The declarative policy CONTRACT — the ONE policy shape an operator writes (caps, allow/deny
 * lists, approval threshold, freeze) plus its validators/builders. This is the PUBLIC part of the
 * policy story, so it lives in @countersign/core (the open interface package): the front door can
 * describe and validate a policy WITHOUT the proprietary compiler. The compiler that lowers this
 * shape to each backend's native controls — the IP — lives in @countersign/policy.
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

/**
 * The ONE declarative policy an operator writes. The compiler lowers it to each backend's
 * native controls; the evaluator (@countersign/policy) is its executable semantics. Keep this small
 * and backend-neutral — every field must mean the same thing on every rail.
 */
export const UnifiedPolicySchema = z
  .strictObject({
    schemaVersion: z.literal(1),
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
    /** Allowed venues/chains by name (see @countersign/policy venues). Absent = any venue. */
    venues: z.array(z.string()).optional(),
  });

export type UnifiedPolicy = z.infer<typeof UnifiedPolicySchema>;

export function parsePolicy(input: unknown): UnifiedPolicy {
  return UnifiedPolicySchema.parse(input);
}

/** Convenience builder for code/tests — fills schemaVersion and validates. */
export function definePolicy(input: Omit<UnifiedPolicy, "schemaVersion">): UnifiedPolicy {
  return UnifiedPolicySchema.parse({ schemaVersion: 1, ...input });
}
