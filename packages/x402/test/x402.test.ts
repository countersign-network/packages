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
  it("carries the asset CONTRACT + decimals through (no longer silently dropped)", () => {
    const c = parseX402(body([opt({ asset: "0xRealUSDC", extra: { name: "USDC", decimals: 6 } })]));
    expect(c?.assetContract).toBe("0xRealUSDC");
    expect(c?.decimals).toBe(6);
  });
});

describe("parseX402 — cross-asset decoy resistance (review D)", () => {
  it("a fewer-decimals decoy with a tiny ATOMIC amount does NOT win the 'cheapest' selection", () => {
    // Real: 1 USDC = 1_000_000 atomic (6-dec). Decoy: "5" atomic of a 0-dec token (worth far more), with
    // a spoofed name. By RAW atomic units "5" < "1000000" and would have been picked; by normalized
    // VALUE the real USDC option is actually cheaper and wins.
    const c = parseX402(body([
      opt({ maxAmountRequired: "1000000", asset: "0xRealUSDC", extra: { name: "USDC", decimals: 6 } }),
      opt({ maxAmountRequired: "5", asset: "0xScamToken", extra: { name: "USDC", decimals: 0 } }),
    ]));
    expect(c?.amount).toBe("1000000");
    expect(c?.assetContract).toBe("0xRealUSDC");
  });

  it("an asset PIN drops a decoy whose extra.name is spoofed, and labels the charge with the trusted symbol", () => {
    const c = parseX402(
      body([
        opt({ maxAmountRequired: "5", asset: "0xScamToken", extra: { name: "usdc", decimals: 6 } }), // spoof (lowercase)
        opt({ maxAmountRequired: "1000000", asset: "0xRealUSDC", extra: { name: "EURC", decimals: 6 } }),
      ]),
      { asset: "EURC" },
    );
    // Only the EURC option survives the pin; the spoofed-"usdc" decoy is dropped even though it's cheaper.
    expect(c?.amount).toBe("1000000");
    expect(c?.asset).toBe("EURC"); // the TRUSTED pin, not extra.name
    expect(c?.assetContract).toBe("0xRealUSDC");
  });

  it("a pin with no matching option → null (the guard won't pay a mislabeled asset)", () => {
    expect(parseX402(body([opt({ extra: { name: "SCAM" } })]), { asset: "USDC" })).toBeNull();
  });

  it("same-asset options still pick the cheapest (no regression for the common case)", () => {
    const c = parseX402(body([
      opt({ maxAmountRequired: "1000", extra: { name: "USDC", decimals: 6 } }),
      opt({ maxAmountRequired: "300", extra: { name: "USDC", decimals: 6 } }),
    ]));
    expect(c?.amount).toBe("300");
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
