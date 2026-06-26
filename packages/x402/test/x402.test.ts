import { describe, it, expect, beforeAll } from "vitest";
import { createDemoCore, createLocalApi } from "@countersign/api";
import type { CountersignApi } from "@countersign/api-contract";
import { parseX402, networkToVenue, guardX402, withX402Guard, X402Denied, type X402PaymentRequired } from "@countersign/x402";

let api: CountersignApi;

beforeAll(async () => {
  const { core } = await createDemoCore(); // default policy: perTxCap 100 USDC, allowlist [0xTREASURY]
  api = createLocalApi(core);
});

const challenge = (amount: string, payTo: string, network = "eip155:84532"): X402PaymentRequired => ({
  x402Version: 1,
  accepts: [{ scheme: "exact", network, maxAmountRequired: amount, payTo, asset: "0xUSDC", extra: { name: "USDC", decimals: 6 } }],
});

describe("@countersign/x402 — govern the machine-payment rail", () => {
  it("maps x402 networks (CAIP-2) to venues", () => {
    expect(networkToVenue("eip155:84532")).toBe("base-sepolia");
    expect(networkToVenue("eip155:80002")).toBe("polygon-amoy");
    expect(networkToVenue("base-sepolia")).toBe("base-sepolia"); // pass-through
  });

  it("parses a 402 challenge to a normalized charge (cheapest option, USDC base units)", () => {
    const charge = parseX402(challenge("50000000", "0xTREASURY"))!;
    expect(charge).toEqual({ amount: "50000000", asset: "USDC", payTo: "0xTREASURY", venue: "base-sepolia", network: "eip155:84532" });
  });

  it("allows an in-policy x402 payment, blocks over-cap and off-allowlist", async () => {
    expect((await guardX402(api, "payments-bot", parseX402(challenge("50000000", "0xTREASURY"))!)).outcome).toBe("allow");
    expect((await guardX402(api, "payments-bot", parseX402(challenge("150000000", "0xTREASURY"))!)).outcome).toBe("deny");
    expect((await guardX402(api, "payments-bot", parseX402(challenge("1", "0xSTRANGER"))!)).outcome).toBe("deny");
  });

  it("withX402Guard only pays when allowed (a rogue/over-budget agent never pays)", async () => {
    let paid = 0;
    const pay = async () => {
      paid++;
      return "paid";
    };

    await expect(withX402Guard(api, "payments-bot", parseX402(challenge("50000000", "0xTREASURY"))!, pay)).resolves.toBe("paid");
    expect(paid).toBe(1);

    await expect(withX402Guard(api, "payments-bot", parseX402(challenge("999000000", "0xTREASURY"))!, pay)).rejects.toBeInstanceOf(X402Denied);
    expect(paid).toBe(1); // unchanged — the payment was never executed
  });
});
