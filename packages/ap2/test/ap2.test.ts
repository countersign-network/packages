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
