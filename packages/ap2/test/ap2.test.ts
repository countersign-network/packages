import { describe, it, expect } from "vitest";
import {
  parseAp2,
  toEvaluateRequest,
  type Ap2CartMandate,
  type Ap2PaymentMandate,
  type Ap2PaymentRequest,
} from "../src/index";

describe("parseAp2 — Gen-2 / v0.2 PaymentMandate (integer minor units)", () => {
  const mandate: Ap2PaymentMandate = {
    vct: "mandate.payment.1",
    transaction_id: "9f8b",
    payee: { id: "merchant_acme_001", name: "Acme Shoes" },
    payment_amount: { amount: 12999, currency: "USD" },
    payment_instrument: { id: "pi_card_42", type: "card", description: "Visa •••• 4242" },
    exp: 1782735900,
  };

  it("passes integer minor units straight through (no conversion)", () => {
    const c = parseAp2(mandate)!;
    expect(c.amount).toBe("12999");
    expect(c.asset).toBe("USD");
    expect(c.payee).toBe("merchant_acme_001");
    expect(c.paymentMethod).toBe("card");
    expect(c.venue).toBe("card");
    expect(c.expiry).toBe("1782735900");
  });

  it("falls back to payee.name then '' when id is absent", () => {
    expect(parseAp2({ ...mandate, payee: { id: "", name: "Acme" } })!.payee).toBe("Acme");
  });
});

describe("parseAp2 — Gen-1 CartMandate (float major units → minor)", () => {
  const cart = (value: number, currency = "USD"): Ap2CartMandate => ({
    contents: {
      id: "cart_abc",
      merchant_name: "Acme Shoes",
      cart_expiry: "2026-06-28T12:30:00Z",
      payment_request: {
        method_data: [{ supported_methods: "card", data: { network: "visa" } }],
        details: { id: "order_987", total: { label: "Total", amount: { currency, value } } },
      },
    },
    merchant_authorization: "eyJ...",
  });

  it("converts float major units to integer minor units (2-decimal default)", () => {
    const c = parseAp2(cart(129.99))!;
    expect(c.amount).toBe("12999"); // 129.99 * 100, rounded past float error (12998.999…)
    expect(c.asset).toBe("USD");
    expect(c.payee).toBe("Acme Shoes");
    expect(c.paymentMethod).toBe("card");
    expect(c.expiry).toBe("2026-06-28T12:30:00Z");
  });

  it("respects 0-decimal currencies (JPY)", () => {
    expect(parseAp2(cart(500, "JPY"))!.amount).toBe("500");
  });

  it("respects 3-decimal currencies (BHD)", () => {
    expect(parseAp2(cart(1.5, "BHD"))!.amount).toBe("1500");
  });
});

describe("parseAp2 — bare PaymentRequest + edge cases", () => {
  it("reads a bare PaymentRequest's committed total", () => {
    const pr: Ap2PaymentRequest = {
      method_data: [{ supported_methods: "x402" }],
      details: { total: { amount: { currency: "USD", value: 5 } } },
    };
    const c = parseAp2({ payment_request: pr })!;
    expect(c.amount).toBe("500");
    expect(c.paymentMethod).toBe("x402");
    expect(c.payee).toBe(""); // no merchant_name on a bare request
  });

  it("returns null when no committed total can be read", () => {
    expect(parseAp2({} as never)).toBeNull();
    expect(parseAp2({ contents: { payment_request: { details: {} } } } as never)).toBeNull();
  });

  it("defaults payment method to 'ap2' when none is offered", () => {
    const c = parseAp2({
      contents: { merchant_name: "M", payment_request: { details: { total: { amount: { currency: "EUR", value: 10 } } } } },
    })!;
    expect(c.paymentMethod).toBe("ap2");
    expect(c.venue).toBe("ap2");
  });
});

describe("toEvaluateRequest", () => {
  it("maps a charge to the Core evaluate request", () => {
    const req = toEvaluateRequest("agent-1", { amount: "12999", asset: "USD", payee: "m1", paymentMethod: "card", venue: "card" });
    expect(req).toEqual({ agentId: "agent-1", amount: "12999", asset: "USD", venue: "card", counterparty: "m1" });
  });

  it("omits counterparty when payee is empty", () => {
    const req = toEvaluateRequest("agent-1", { amount: "500", asset: "USD", payee: "", paymentMethod: "ap2", venue: "ap2" });
    expect(req).not.toHaveProperty("counterparty");
  });
});

/**
 * Fail-closed parsing regressions. parseAp2's contract is "return null if no committed total can be
 * read" — it must NOT emit a bogus charge ("NaN"/"Infinity") and lean on the Core regex, and it must
 * not crash on a missing currency. Plus the currency-decimal table must cover all ISO-4217 0-dec codes.
 */
describe("parseAp2 — fail-closed on malformed amounts/currency", () => {
  it("Gen-2 NaN / Infinity / negative amount → null (not a 'NaN'/'Infinity' charge)", () => {
    expect(parseAp2({ payment_amount: { amount: NaN, currency: "USD" } } as unknown as Ap2PaymentMandate)).toBeNull();
    expect(parseAp2({ payment_amount: { amount: Infinity, currency: "USD" } } as unknown as Ap2PaymentMandate)).toBeNull();
    expect(parseAp2({ payment_amount: { amount: -100, currency: "USD" } } as unknown as Ap2PaymentMandate)).toBeNull();
  });
  it("Gen-2 missing/empty currency → null", () => {
    expect(parseAp2({ payment_amount: { amount: 500 } } as unknown as Ap2PaymentMandate)).toBeNull();
    expect(parseAp2({ payment_amount: { amount: 500, currency: "" } } as unknown as Ap2PaymentMandate)).toBeNull();
  });
  it("Gen-1 NaN / Infinity / negative value → null", () => {
    const m = (value: number): Ap2CartMandate => ({ contents: { payment_request: { details: { total: { amount: { value, currency: "USD" } } } } } } as unknown as Ap2CartMandate);
    expect(parseAp2(m(NaN))).toBeNull();
    expect(parseAp2(m(Infinity))).toBeNull();
    expect(parseAp2(m(-5))).toBeNull();
  });
  it("Gen-1 missing currency → null (does not throw in decimalsFor)", () => {
    const m = { contents: { payment_request: { details: { total: { amount: { value: 5 } } } } } } as unknown as Ap2CartMandate;
    expect(parseAp2(m)).toBeNull();
  });
});

describe("parseAp2 — currency-decimal coverage (Gen-1 major→minor)", () => {
  const cart = (value: number, currency: string): Ap2CartMandate =>
    ({ contents: { merchant_name: "M", payment_request: { details: { total: { amount: { value, currency } } } } } } as unknown as Ap2CartMandate);
  it("the remaining ISO-4217 zero-decimal currencies convert 1:1 (no phantom ×100)", () => {
    for (const cur of ["BIF", "DJF", "GNF", "KMF", "UYI", "JPY", "KRW"]) {
      expect(parseAp2(cart(500, cur))?.amount).toBe("500"); // 0-decimal: 500 major == 500 minor
    }
  });
  it("3-decimal currency (KWD) scales by 1000", () => {
    expect(parseAp2(cart(5, "KWD"))?.amount).toBe("5000");
  });
  it("default 2-decimal currency (USD) scales by 100", () => {
    expect(parseAp2(cart(5, "USD"))?.amount).toBe("500");
  });
});
