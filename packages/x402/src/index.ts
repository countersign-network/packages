/**
 * @countersign/x402 — govern x402 (the dominant HTTP-402 machine-payment rail) as a first-class Countersign
 * action. An agent that hits an x402 "payment required" challenge routes it through Countersign's
 * pre-flight guard BEFORE paying: parse the challenge → evaluate against policy (per-call caps +
 * payee allowlist + daily metering) → only hand off to the wallet/x402 client if allowed.
 *
 * Countersign decides; it never signs or moves funds (prime directive #1). USDC is the settlement asset,
 * so x402's atomic amounts map straight onto Countersign's base-unit policy.
 */

import type { CountersignApi, EvaluateRequest, EvaluateResponse } from "@countersign/api-contract";

// Public chain-id map for the supported testnet venues (inlined so this front-door package carries no
// dependency on the proprietary policy compiler — kept in sync with packages/policy/src/venues.ts).
const VENUE_CHAIN_IDS: Readonly<Record<string, number>> = {
  "base-sepolia": 84532,
  "ethereum-sepolia": 11155111,
  "polygon-amoy": 80002,
  "optimism-sepolia": 11155420,
};

/** An entry from an x402 "accepts" array (v2 "exact" scheme, EVM). */
export interface X402Accepts {
  scheme: string; // e.g. "exact"
  network: string; // CAIP-2 ("eip155:84532") or a venue name ("base-sepolia")
  maxAmountRequired: string; // atomic units (USDC = 6 decimals)
  payTo: string;
  asset: string; // token contract address
  resource?: string;
  extra?: { name?: string; decimals?: number };
}

export interface X402PaymentRequired {
  x402Version?: number;
  accepts: X402Accepts[];
  error?: string;
}

/** A normalized charge ready to evaluate against a Countersign policy. */
export interface X402Charge {
  amount: string; // base units (atomic)
  asset: string; // symbol, e.g. "USDC"
  assetContract: string; // the token CONTRACT from the challenge (the authoritative asset identity)
  decimals: number; // the token's decimals for `amount`
  payTo: string;
  venue: string;
  network: string;
}

export interface ParseX402Options {
  /**
   * Pin the settlement asset SYMBOL you expect to pay (e.g. "USDC"). STRONGLY RECOMMENDED. When set,
   * ONLY options whose `extra.name` matches (case-insensitive) are considered, and the returned charge's
   * `asset` is this TRUSTED value — not the attacker-controlled `extra.name`. Without a pin, a 402 body
   * can list a decoy option (a different, worthless token) with a tiny amount and a spoofed
   * `extra.name: "USDC"`; pinning drops the decoy so it can't be selected and mislabeled as your policy's
   * asset. (The Core's asset gate is the backstop; this closes the hole at the source.)
   */
  asset?: string;
}

// Compare amounts across options by DECIMALS-NORMALIZED value, not raw atomic units: an option in a
// fewer-decimals (or spoofed) token could otherwise show a smaller atomic number and be picked as
// "cheapest" while being worth far more. 36 dp is safely above any real token's precision.
const NORMALIZE_DP = 36;
const DEFAULT_DECIMALS = 6; // USDC settlement default
const normalizedValue = (atomic: string, decimals: number): bigint => {
  const dec = Math.min(Math.max(Math.trunc(decimals), 0), NORMALIZE_DP);
  return BigInt(atomic) * 10n ** BigInt(NORMALIZE_DP - dec);
};

const CAIP_TO_VENUE: Record<string, string> = Object.fromEntries(
  Object.entries(VENUE_CHAIN_IDS).map(([venue, id]) => [`eip155:${id}`, venue]),
);

/** Map an x402 network (CAIP-2 or name) to a Countersign venue. Unknown networks pass through as-is. */
export function networkToVenue(network: string): string {
  return CAIP_TO_VENUE[network] ?? network;
}

/**
 * Normalize an x402 "payment required" challenge into a single charge to evaluate. Picks the
 * cheapest acceptable option (agents should pay the least). Returns null if there are no options.
 */
export function parseX402(body: X402PaymentRequired, opts: ParseX402Options = {}): X402Charge | null {
  // Only consider options whose amount is a clean non-negative integer. `BigInt` is lenient —
  // BigInt("-5")=-5n, BigInt("0x01")=1n, BigInt("")=0n — so a hostile/ malformed 402 body could
  // otherwise have a negative/hex/empty amount selected as "cheapest" and the raw string smuggled
  // downstream, or a non-numeric value ("1.5") throw mid-sort and discard the whole challenge.
  // Filter to the policy's own amount rule (^\d+$) first; no valid option => null (the guard won't pay).
  let options = (body.accepts ?? []).filter((o) => typeof o.maxAmountRequired === "string" && /^\d+$/.test(o.maxAmountRequired));
  // Same rule for a PRESENT `extra.decimals`: it is attacker-controlled JSON, and a non-numeric value
  // (NaN survives the min/max clamp in normalizedValue) would throw at BigInt() mid-sort and discard the
  // whole challenge. A present-but-garbage decimals field marks a malformed/hostile option — drop it,
  // keep the rest. (ABSENT decimals stays fine and defaults to DEFAULT_DECIMALS.)
  options = options.filter((o) => o.extra?.decimals === undefined || Number.isFinite(o.extra.decimals));
  // Asset pin (recommended): keep only options that declare the expected symbol, so a decoy option in a
  // different token can't be selected and mislabeled as the caller's asset.
  if (opts.asset) {
    const want = opts.asset.toLowerCase();
    options = options.filter((o) => (o.extra?.name ?? "").toLowerCase() === want);
  }
  if (options.length === 0) return null;
  // Pick the cheapest by decimals-NORMALIZED value (not raw atomic units) so a different-decimals option
  // can't win the selection purely by showing a smaller atomic number.
  const decimalsOf = (o: X402Accepts): number => o.extra?.decimals ?? DEFAULT_DECIMALS;
  const cheapest = [...options].sort((a, b) => {
    const va = normalizedValue(a.maxAmountRequired, decimalsOf(a));
    const vb = normalizedValue(b.maxAmountRequired, decimalsOf(b));
    return va < vb ? -1 : va > vb ? 1 : 0;
  })[0]!;
  return {
    amount: cheapest.maxAmountRequired,
    // Prefer the caller's PINNED symbol over the challenge-supplied (attacker-controlled) extra.name.
    asset: opts.asset ?? cheapest.extra?.name ?? "USDC",
    assetContract: cheapest.asset,
    decimals: decimalsOf(cheapest),
    payTo: cheapest.payTo,
    venue: networkToVenue(cheapest.network),
    network: cheapest.network,
  };
}

export function toEvaluateRequest(agentId: string, charge: X402Charge): EvaluateRequest {
  return { agentId, amount: charge.amount, asset: charge.asset, counterparty: charge.payTo, venue: charge.venue };
}

/** Ask Countersign whether this x402 payment is allowed. */
export function guardX402(api: CountersignApi, agentId: string, charge: X402Charge): Promise<EvaluateResponse> {
  return api.evaluate(toEvaluateRequest(agentId, charge));
}

export class X402Denied extends Error {
  constructor(readonly decision: EvaluateResponse) {
    super(`x402 payment ${decision.outcome}${decision.reason ? `: ${decision.reason}` : ""}`);
    this.name = "X402Denied";
  }
}

/**
 * Wrap the actual payment: evaluate first, and only run `pay` if Countersign allows. Throws X402Denied
 * (carrying the decision) on deny / needs_approval, so a rogue or over-budget agent never pays.
 */
export async function withX402Guard<T>(
  api: CountersignApi,
  agentId: string,
  charge: X402Charge,
  pay: (charge: X402Charge) => Promise<T>,
): Promise<T> {
  const decision = await guardX402(api, agentId, charge);
  if (decision.outcome !== "allow") throw new X402Denied(decision);
  return pay(charge);
}
