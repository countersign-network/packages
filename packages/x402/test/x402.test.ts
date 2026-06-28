import { describe, it, expect } from "vitest";
import type { CountersignApi, EvaluateRequest, EvaluateResponse } from "@countersign/api-contract";
import { parseX402, networkToVenue, guardX402, withX402Guard, X402Denied, type X402PaymentRequired } from "../src/index";

const opt = (over: Partial<X402PaymentRequired["accepts"][number]> = {}): X402PaymentRequired["accepts"][number] => ({
  scheme: "exact",
  network: "base-sepolia",
  maxAmountRequired: "1000",
  payTo: "0x1111111111111111111111111111111111111111",
  asset: "0xUSDCcontract",
  ...over,
});
const body = (accepts: X402PaymentRequired["accepts"]): X402PaymentRequired => ({ x402Version: 1, accepts });

describe("parseX402 — cheapest-option selection", () => {
  it("picks the cheapest of several options", () => {
    const c = parseX402(body([opt({ maxAmountRequired: "1000" }), opt({ maxAmountRequired: "50" }), opt({ maxAmountRequired: "300" })]));
    expect(c?.amount).toBe("50");
  });
  it("a single option is returned as-is", () => {
    expect(parseX402(body([opt({ maxAmountRequired: "777" })]))?.amount).toBe("777");
  });
  it("empty / missing accepts → null", () => {
    expect(parseX402(body([]))).toBeNull();
    expect(parseX402({ accepts: undefined as unknown as X402PaymentRequired["accepts"] })).toBeNull();
  });
});

describe("parseX402 — fail-closed amount filtering (lenient BigInt is hostile)", () => {
  it("skips a NEGATIVE amount instead of selecting it as 'cheapest'", () => {
    // BigInt('-5') = -5n would otherwise sort first and smuggle '-5' downstream.
    const c = parseX402(body([opt({ maxAmountRequired: "1000" }), opt({ maxAmountRequired: "-5" }), opt({ maxAmountRequired: "50" })]));
    expect(c?.amount).toBe("50");
  });
  it("skips hex / empty / decimal / non-numeric amounts; all-invalid → null (no throw)", () => {
    for (const bad of ["0x01", "", "1.5", " 10", "abc", "1e9"]) {
      expect(parseX402(body([opt({ maxAmountRequired: bad })]))).toBeNull();
    }
    // mixed: only the valid integer survives
    expect(parseX402(body([opt({ maxAmountRequired: "0x10" }), opt({ maxAmountRequired: "42" })]))?.amount).toBe("42");
  });
});

describe("parseX402 — venue + asset mapping", () => {
  it("maps CAIP-2 to a venue and passes a venue name through", () => {
    expect(parseX402(body([opt({ network: "eip155:84532" })]))?.venue).toBe("base-sepolia");
    expect(parseX402(body([opt({ network: "base-sepolia" })]))?.venue).toBe("base-sepolia");
  });
  it("an unknown network passes through verbatim", () => {
    expect(networkToVenue("solana:devnet")).toBe("solana:devnet");
    expect(parseX402(body([opt({ network: "solana:devnet" })]))?.network).toBe("solana:devnet");
  });
  it("asset symbol comes from extra.name, defaulting to USDC", () => {
    expect(parseX402(body([opt({ extra: { name: "EURC" } })]))?.asset).toBe("EURC");
    expect(parseX402(body([opt({})]))?.asset).toBe("USDC");
  });
});

// A minimal fake Core that records the evaluate request and returns a scripted decision.
function fakeApi(decision: EvaluateResponse): { api: CountersignApi; seen: EvaluateRequest[] } {
  const seen: EvaluateRequest[] = [];
  const api = { evaluate: async (req: EvaluateRequest) => { seen.push(req); return decision; } } as unknown as CountersignApi;
  return { api, seen };
}

describe("guardX402 / withX402Guard", () => {
  it("guardX402 evaluates the charge against the right agent/amount/counterparty/venue", async () => {
    const { api, seen } = fakeApi({ outcome: "allow", policyId: "p" });
    const charge = parseX402(body([opt({ maxAmountRequired: "100", payTo: "0x2222222222222222222222222222222222222222" })]))!;
    await guardX402(api, "bot", charge);
    expect(seen[0]).toMatchObject({ agentId: "bot", amount: "100", counterparty: "0x2222222222222222222222222222222222222222", venue: "base-sepolia" });
  });
  it("withX402Guard runs the payment ONLY on allow", async () => {
    const { api } = fakeApi({ outcome: "allow", policyId: "p" });
    const charge = parseX402(body([opt()]))!;
    let paid = false;
    const out = await withX402Guard(api, "bot", charge, async () => { paid = true; return "tx-hash"; });
    expect(paid).toBe(true);
    expect(out).toBe("tx-hash");
  });
  it("withX402Guard throws X402Denied (carrying the decision) on deny — the agent never pays", async () => {
    const { api } = fakeApi({ outcome: "deny", reason: "over cap", policyId: "p" });
    const charge = parseX402(body([opt()]))!;
    let paid = false;
    await expect(withX402Guard(api, "bot", charge, async () => { paid = true; return "x"; })).rejects.toBeInstanceOf(X402Denied);
    expect(paid).toBe(false);
  });
  it("withX402Guard also blocks needs_approval (only allow proceeds)", async () => {
    const { api } = fakeApi({ outcome: "needs_approval", reason: "over threshold", approvalToken: "appr_1", policyId: "p" });
    const charge = parseX402(body([opt()]))!;
    await expect(withX402Guard(api, "bot", charge, async () => "x")).rejects.toBeInstanceOf(X402Denied);
  });
});
