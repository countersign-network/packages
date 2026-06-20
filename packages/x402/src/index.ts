/**
 * @cosign/x402 — govern x402 (the dominant HTTP-402 machine-payment rail) as a first-class Cosign
 * action. An agent that hits an x402 "payment required" challenge routes it through Cosign's
 * pre-flight guard BEFORE paying: parse the challenge → evaluate against policy (per-call caps +
 * payee allowlist + daily metering) → only hand off to the wallet/x402 client if allowed.
 *
 * Cosign decides; it never signs or moves funds (prime directive #1). USDC is the settlement asset,
 * so x402's atomic amounts map straight onto Cosign's base-unit policy.
 */

import type { CosignApi, EvaluateRequest, EvaluateResponse } from "@cosign/api-contract";
import { VENUE_CHAIN_IDS } from "@cosign/policy";

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

/** A normalized charge ready to evaluate against a Cosign policy. */
export interface X402Charge {
  amount: string; // base units
  asset: string; // symbol, e.g. "USDC"
  payTo: string;
  venue: string;
  network: string;
}

const CAIP_TO_VENUE: Record<string, string> = Object.fromEntries(
  Object.entries(VENUE_CHAIN_IDS).map(([venue, id]) => [`eip155:${id}`, venue]),
);

/** Map an x402 network (CAIP-2 or name) to a Cosign venue. Unknown networks pass through as-is. */
export function networkToVenue(network: string): string {
  return CAIP_TO_VENUE[network] ?? network;
}

/**
 * Normalize an x402 "payment required" challenge into a single charge to evaluate. Picks the
 * cheapest acceptable option (agents should pay the least). Returns null if there are no options.
 */
export function parseX402(body: X402PaymentRequired): X402Charge | null {
  const options = body.accepts ?? [];
  if (options.length === 0) return null;
  const cheapest = [...options].sort((a, b) => (BigInt(a.maxAmountRequired) < BigInt(b.maxAmountRequired) ? -1 : 1))[0]!;
  return {
    amount: cheapest.maxAmountRequired,
    asset: cheapest.extra?.name ?? "USDC",
    payTo: cheapest.payTo,
    venue: networkToVenue(cheapest.network),
    network: cheapest.network,
  };
}

export function toEvaluateRequest(agentId: string, charge: X402Charge): EvaluateRequest {
  return { agentId, amount: charge.amount, asset: charge.asset, counterparty: charge.payTo, venue: charge.venue };
}

/** Ask Cosign whether this x402 payment is allowed. */
export function guardX402(api: CosignApi, agentId: string, charge: X402Charge): Promise<EvaluateResponse> {
  return api.evaluate(toEvaluateRequest(agentId, charge));
}

export class X402Denied extends Error {
  constructor(readonly decision: EvaluateResponse) {
    super(`x402 payment ${decision.outcome}${decision.reason ? `: ${decision.reason}` : ""}`);
    this.name = "X402Denied";
  }
}

/**
 * Wrap the actual payment: evaluate first, and only run `pay` if Cosign allows. Throws X402Denied
 * (carrying the decision) on deny / needs_approval, so a rogue or over-budget agent never pays.
 */
export async function withX402Guard<T>(
  api: CosignApi,
  agentId: string,
  charge: X402Charge,
  pay: (charge: X402Charge) => Promise<T>,
): Promise<T> {
  const decision = await guardX402(api, agentId, charge);
  if (decision.outcome !== "allow") throw new X402Denied(decision);
  return pay(charge);
}
