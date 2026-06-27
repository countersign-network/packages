import { describe, it, expect } from "vitest";
import { asAgentId } from "@countersign/core";
import { definePolicy } from "@countersign/policy";
import type { CdpClient } from "@coinbase/cdp-sdk";
import { CoinbaseProvider } from "../src/index";

/**
 * Offline unit test of the LIVE Coinbase adapter's fail-closed freeze (no creds — a fake CDP client is
 * injected via the constructor seam). Regression guard for the bug where freeze() returned
 * confirmed:true unconditionally even when the native deny-all push failed.
 */
function fakeCdp(opts: { freezeFails?: boolean; onSend?: () => void } = {}): CdpClient {
  return {
    evm: {
      createAccount: async () => ({ address: "0x000000000000000000000000000000000000c0de" }),
      updateAccount: async () => ({ accountPolicy: "pol_deny" }),
      sendTransaction: async () => {
        opts.onSend?.();
        return { transactionHash: "0xdead" };
      },
    },
    policies: {
      createPolicy: async () => {
        if (opts.freezeFails) throw new Error("CDP 403: policies#manage scope missing");
        return { id: "pol_deny" };
      },
    },
  } as unknown as CdpClient;
}

describe("Coinbase freeze is fail-closed (confirm by native success, not hard-coded true)", () => {
  it("confirms when the native deny-all policy attaches + reads back", async () => {
    const p = new CoinbaseProvider(fakeCdp());
    await p.provisionWallet(asAgentId("a"), { venue: "base-sepolia" });
    const r = await p.freeze({ kind: "provider-all" });
    expect(r.confirmed).toBe(true);
    expect(r.frozenAgents).toEqual([asAgentId("a")]);
  });

  it("does NOT confirm when the native deny-all push fails — so the controller escalates", async () => {
    const p = new CoinbaseProvider(fakeCdp({ freezeFails: true }));
    await p.provisionWallet(asAgentId("a"), { venue: "base-sepolia" });
    const r = await p.freeze({ kind: "provider-all" });
    expect(r.confirmed).toBe(false); // was hard-coded true before the fix — the fail-closed bug
  });
});

describe("Coinbase daily cap holds under concurrent spends (TOCTOU)", () => {
  it("two in-flight spends that together exceed the daily cap don't both land", async () => {
    let sends = 0;
    const p = new CoinbaseProvider(fakeCdp({ onSend: () => void (sends += 1) }));
    const a = asAgentId("a");
    await p.provisionWallet(a, { venue: "base-sepolia" });
    // Daily cap 100; no per-tx cap. Two concurrent 60s = 120 > 100 → exactly one may land.
    await p.applyPolicy(a, definePolicy({ asset: "USDC", dailyCap: "100" }));

    const attempt = { amount: "60", asset: "USDC", venue: "base-sepolia" as const };
    const [r1, r2] = await Promise.all([p.attemptSpend(a, attempt), p.attemptSpend(a, attempt)]);

    const outcomes = [r1.outcome, r2.outcome].sort();
    expect(outcomes).toEqual(["allowed", "blocked"]); // not ["allowed","allowed"] — the cap held
    expect(sends).toBe(1); // only the reserved spend actually hit the chain
  });
});
