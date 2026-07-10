/**
 * @countersign/ap2 — govern AP2 (the Agent Payments Protocol) as a first-class Countersign action.
 * When an agent is about to commit to a merchant-signed Cart/Checkout Mandate — i.e. just before it
 * signs the PaymentMandate and funds can move — it routes the mandate through Countersign's pre-flight
 * guard: parse the committed (amount, currency, payee, method) → evaluate against policy (per-call caps
 * + payee allowlist + daily metering) → only sign/send the PaymentMandate if allowed.
 *
 * Countersign decides; it never signs a mandate or moves funds (prime directive #1).
 *
 * AP2 (github.com/google-agentic-commerce/AP2, spec v0.2) has NO official npm/TS SDK yet and ships
 * TWO model generations whose amount conventions DIFFER — this parser handles both:
 *   • Gen-1 (W3C PaymentRequest based): `CartMandate.contents.payment_request.details.total.amount`
 *     = { currency, value } where `value` is a FLOAT in MAJOR units (e.g. 129.99).
 *   • Gen-2 / v0.2 (SD-JWT VC):         `PaymentMandate.payment_amount`
 *     = { amount, currency } where `amount` is an INT in MINOR units (e.g. 12999 = $129.99).
 * Both are normalized to an integer minor-unit string — Countersign's base-unit policy amount.
 */

import type { CountersignApi, EvaluateRequest, EvaluateResponse } from "@countersign/api-contract";

/* ---------- AP2 mandate shapes (transcribed from the reference schemas; no official TS SDK) ---------- */

/** Gen-1: W3C-PaymentRequest monetary amount — `value` is a FLOAT in MAJOR units. */
export interface Ap2CurrencyAmount {
  currency: string; // ISO-4217 3-letter
  value: number; // major units (e.g. 129.99)
}
export interface Ap2PaymentItem {
  label?: string;
  amount: Ap2CurrencyAmount;
}
export interface Ap2PaymentMethodData {
  supported_methods: string; // payment-method identifier (card network, x402 method id, ...)
  data?: Record<string, unknown>;
}
export interface Ap2PaymentRequest {
  method_data?: Ap2PaymentMethodData[];
  details: { id?: string; total: Ap2PaymentItem; display_items?: Ap2PaymentItem[] };
}
export interface Ap2CartContents {
  id?: string;
  payment_request: Ap2PaymentRequest;
  cart_expiry?: string; // ISO 8601
  merchant_name?: string;
}
/** Gen-1 CartMandate — the merchant-signed commitment of items + price. */
export interface Ap2CartMandate {
  contents: Ap2CartContents;
  merchant_authorization?: string | null;
}

/** Gen-2 / v0.2: amount is an INT in MINOR units (per ISO-4217), e.g. 12999 = $129.99. */
export interface Ap2Amount {
  amount: number; // minor units (integer)
  currency: string; // ISO-4217 3-letter
}
export interface Ap2Merchant {
  id: string;
  name?: string;
  website?: string | null;
}
export interface Ap2PaymentInstrument {
  id?: string;
  type: string; // instrument category: "card" | "bank" | "x402" | ...
  description?: string | null;
}
/** Gen-2 PaymentMandate — what the network/issuer is told. */
export interface Ap2PaymentMandate {
  vct?: string; // e.g. "mandate.payment.1"
  transaction_id?: string;
  payee: Ap2Merchant;
  payment_amount: Ap2Amount;
  payment_instrument?: Ap2PaymentInstrument;
  exp?: number | null; // Unix epoch
}

/** Any AP2 object carrying a committed charge that we know how to read. */
export type Ap2Mandate = Ap2CartMandate | Ap2PaymentMandate | { payment_request: Ap2PaymentRequest };

/** A normalized charge ready to evaluate against a Countersign policy. */
export interface Ap2Charge {
  amount: string; // integer minor units (base units), e.g. "12999"
  asset: string; // ISO-4217 currency symbol, e.g. "USD"
  payee: string; // merchant / payee identifier
  paymentMethod: string; // instrument type/id, e.g. "card", "x402"
  venue: string; // = paymentMethod (or "ap2" when unknown)
  expiry?: string; // ISO 8601 (Gen-1) or stringified Unix epoch (Gen-2), informational
}

// ISO-4217 minor-unit exponents for the Gen-1 major→minor conversion. Default 2 covers the common case;
// the exceptions are the 0-decimal and 3-decimal currencies. (Gen-2 is already minor units — no conversion.)
const CURRENCY_DECIMALS: Readonly<Record<string, number>> = {
  JPY: 0, KRW: 0, CLP: 0, ISK: 0, VND: 0, XOF: 0, XAF: 0, PYG: 0, RWF: 0, UGX: 0, VUV: 0, XPF: 0,
  BIF: 0, DJF: 0, GNF: 0, KMF: 0, UYI: 0, // the remaining ISO-4217 zero-decimal currencies
  BHD: 3, IQD: 3, JOD: 3, KWD: 3, LYD: 3, OMR: 3, TND: 3,
  CLF: 4, UYW: 4, // the ISO-4217 four-decimal unit-of-account codes (else a 100x under-report)
};
const decimalsFor = (currency: string): number => CURRENCY_DECIMALS[currency.toUpperCase()] ?? 2;

/** Convert a Gen-1 float major-unit amount to an integer minor-unit string for policy evaluation. */
function majorToMinor(value: number, currency: string): string {
  const minor = Math.round(Math.abs(value) * 10 ** decimalsFor(currency));
  return String(minor);
}

const isPaymentMandate = (m: Ap2Mandate): m is Ap2PaymentMandate =>
  typeof (m as Ap2PaymentMandate).payment_amount === "object" && (m as Ap2PaymentMandate).payment_amount != null;
const isCartMandate = (m: Ap2Mandate): m is Ap2CartMandate =>
  typeof (m as Ap2CartMandate).contents === "object" && (m as Ap2CartMandate).contents != null;

/**
 * Normalize an AP2 mandate (Gen-1 CartMandate, Gen-2 PaymentMandate, or a bare PaymentRequest) into a
 * single charge to evaluate. Returns null if no committed total can be read.
 */
export function parseAp2(mandate: Ap2Mandate): Ap2Charge | null {
  // Gen-2 / v0.2 PaymentMandate — integer minor units.
  if (isPaymentMandate(mandate)) {
    const { payment_amount: amt, payee, payment_instrument: pi, exp } = mandate;
    // Reject anything that isn't a finite, non-negative amount with a usable currency. typeof NaN /
    // Infinity is "number", so a bare typeof check would emit a bogus "NaN"/"Infinity" charge instead
    // of null (the documented contract) and lean on the Core regex to deny. Fail-closed here: null.
    if (!amt || typeof amt.amount !== "number" || !Number.isFinite(amt.amount) || amt.amount < 0) return null;
    // The Gen-2 contract is INTEGER minor units. A non-integer (e.g. a Gen-1 major-unit float like
    // 129.99 mistakenly placed in this minor-unit field) must be REJECTED, not silently truncated to
    // 129 — a ~100x under-report that would clear a per-tx cap it should breach. Fail-closed, mirroring
    // x402's strict atomic-amount gate.
    if (!Number.isInteger(amt.amount)) return null;
    if (typeof amt.currency !== "string" || amt.currency === "") return null;
    const method = pi?.type ?? pi?.id ?? "ap2";
    return {
      // Now guaranteed a non-negative integer; BigInt yields a clean decimal string at any magnitude.
      amount: BigInt(amt.amount).toString(),
      asset: amt.currency,
      payee: payee?.id || payee?.name || "",
      paymentMethod: method,
      venue: method,
      ...(exp != null ? { expiry: String(exp) } : {}),
    };
  }

  // Gen-1 CartMandate or a bare PaymentRequest — float major units via W3C PaymentRequest.
  const pr: Ap2PaymentRequest | undefined = isCartMandate(mandate)
    ? mandate.contents.payment_request
    : (mandate as { payment_request?: Ap2PaymentRequest }).payment_request;
  const total = pr?.details?.total?.amount;
  // Same fail-closed contract as Gen-2: finite, non-negative value with a usable currency, else null.
  // (Guards both NaN/Infinity and a missing currency, which would otherwise throw in decimalsFor.)
  if (!pr || !total || typeof total.value !== "number" || !Number.isFinite(total.value) || total.value < 0) return null;
  if (typeof total.currency !== "string" || total.currency === "") return null;
  const method = pr.method_data?.[0]?.supported_methods ?? "ap2";
  const payee = isCartMandate(mandate) ? mandate.contents.merchant_name ?? "" : "";
  const expiry = isCartMandate(mandate) ? mandate.contents.cart_expiry : undefined;
  return {
    amount: majorToMinor(total.value, total.currency),
    asset: total.currency,
    payee,
    paymentMethod: method,
    venue: method,
    ...(expiry ? { expiry } : {}),
  };
}

export function toEvaluateRequest(agentId: string, charge: Ap2Charge): EvaluateRequest {
  return {
    agentId,
    amount: charge.amount,
    asset: charge.asset,
    venue: charge.venue,
    ...(charge.payee ? { counterparty: charge.payee } : {}),
  };
}

/** Ask Countersign whether this AP2 payment is allowed. */
export function guardAp2(api: CountersignApi, agentId: string, charge: Ap2Charge): Promise<EvaluateResponse> {
  return api.evaluate(toEvaluateRequest(agentId, charge));
}

export class Ap2Denied extends Error {
  constructor(readonly decision: EvaluateResponse) {
    super(`AP2 payment ${decision.outcome}${decision.reason ? `: ${decision.reason}` : ""}`);
    this.name = "Ap2Denied";
  }
}

/**
 * Wrap the actual mandate signing/sending: evaluate first, and only run `pay` if Countersign allows.
 * Throws Ap2Denied (carrying the decision) on deny / needs_approval, so a rogue or over-budget agent
 * never signs the PaymentMandate.
 */
export async function withAp2Guard<T>(
  api: CountersignApi,
  agentId: string,
  charge: Ap2Charge,
  pay: (charge: Ap2Charge) => Promise<T>,
): Promise<T> {
  const decision = await guardAp2(api, agentId, charge);
  if (decision.outcome !== "allow") throw new Ap2Denied(decision);
  return pay(charge);
}
