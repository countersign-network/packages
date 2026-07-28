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
  // Pick the cheapest by decimals-NORMALIZED value (not raw atomic units) so a different-decimals option
  // can't win the selection purely by showing a smaller atomic number.
  const decimalsOf = (o: X402Accepts): number => o.extra?.decimals ?? DEFAULT_DECIMALS;
  const [cheapest] = [...options].sort((a, b) => {
    const va = normalizedValue(a.maxAmountRequired, decimalsOf(a));
    const vb = normalizedValue(b.maxAmountRequired, decimalsOf(b));
    return va < vb ? -1 : va > vb ? 1 : 0;
  });
  // No acceptable option — empty `accepts`, or every option dropped by the filters above. Checking the
  // selected value itself (rather than `options.length` before the sort) keeps the emptiness invariant
  // adjacent to its use: a later change to the filters can't strand a non-null assertion here, which
  // would silently hand `undefined` to the field reads below instead of refusing to pay.
  if (!cheapest) return null;
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

/**
 * Lower a parsed charge to a Core evaluate request.
 *
 * `assetContract` and `decimals` are forwarded, not dropped: `asset` is a symbol, and the symbol on an
 * x402 option is attacker-controlled unless the caller pinned it. Sending the contract address the
 * challenge actually named means the Core's asset gate — the backstop — can check identity rather than
 * a label. Both fields are optional on the wire, so a Core that predates them ignores them.
 */
export function toEvaluateRequest(agentId: string, charge: X402Charge): EvaluateRequest {
  return {
    agentId,
    amount: charge.amount,
    asset: charge.asset,
    assetContract: charge.assetContract,
    decimals: charge.decimals,
    counterparty: charge.payTo,
    venue: charge.venue,
  };
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
 * Default bound on the Core round-trip inside {@link withX402Guard}.
 *
 * A Core that THROWS is already handled — the rejection propagates and `pay` never runs. The gap is a
 * Core that is alive but never answers: without a bound the agent waits forever, so the payment neither
 * happens nor fails, and no error ever reaches the caller to retry or alert on. An unattended agent
 * simply stops.
 *
 * Deliberately generous rather than matching the freeze controller's 800ms. Freeze is an emergency stop
 * where an aggressive cutoff is the right trade; evaluate sits on the happy path of every payment, and a
 * cold-started Core can legitimately take seconds. The goal here is BOUNDED, not fast — too tight a
 * default would convert ordinary latency into refused payments.
 */
export const DEFAULT_EVALUATE_TIMEOUT_MS = 10_000;

/**
 * Thrown when Countersign did not return a decision within the bound. Deliberately NOT an
 * {@link X402Denied}: there is no decision to carry. The payment is refused because none arrived —
 * fail-closed, which is not the same as having been denied, and callers should be able to tell the
 * difference (retry/alert vs. respect a policy refusal).
 */
export class X402EvaluateTimeout extends Error {
  constructor(readonly timeoutMs: number) {
    super(`x402 guard: no decision from Countersign within ${timeoutMs}ms — payment refused (fail-closed)`);
    this.name = "X402EvaluateTimeout";
  }
}

export interface WithX402GuardOptions {
  /**
   * Bound on the Core round-trip, in ms. Defaults to {@link DEFAULT_EVALUATE_TIMEOUT_MS}. Pass
   * `Infinity` to wait indefinitely (the historical behaviour) — not recommended for unattended agents,
   * since that reintroduces the indefinite hang this bound exists to prevent.
   */
  evaluateTimeoutMs?: number;
}

/**
 * Reject if `p` has not settled within `ms`. Unlike the freeze controller's `withTimeout` — which
 * resolves to a non-ok result because it aggregates across providers — this one REJECTS, because the
 * only correct outcome here is that `pay` is never reached.
 */
function bounded<T>(p: Promise<T>, ms: number): Promise<T> {
  if (!Number.isFinite(ms)) return p; // explicitly opted out
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new X402EvaluateTimeout(ms)), ms);
    p.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/**
 * Wrap the actual payment: evaluate first, and only run `pay` if Countersign allows. Throws X402Denied
 * (carrying the decision) on deny / needs_approval, so a rogue or over-budget agent never pays, and
 * X402EvaluateTimeout if no decision arrives in time. Every non-allow path — deny, approval required,
 * network error, silence — leaves `pay` unreached.
 */
export async function withX402Guard<T>(
  api: CountersignApi,
  agentId: string,
  charge: X402Charge,
  pay: (charge: X402Charge) => Promise<T>,
  opts: WithX402GuardOptions = {},
): Promise<T> {
  const timeoutMs = opts.evaluateTimeoutMs ?? DEFAULT_EVALUATE_TIMEOUT_MS;
  const decision = await bounded(guardX402(api, agentId, charge), timeoutMs);
  if (decision.outcome !== "allow") throw new X402Denied(decision);
  return pay(charge);
}
