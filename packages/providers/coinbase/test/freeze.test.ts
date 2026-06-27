import { describe, it, expect } from "vitest";
import { asAgentId } from "@countersign/core";
import type { CdpClient } from "@coinbase/cdp-sdk";
import { CoinbaseProvider } from "../src/index";

/**
 * Offline unit test of the LIVE Coinbase adapter's fail-closed freeze (no creds — a fake CDP client is
 * injected via the constructor seam). Regression guard for the bug where freeze() returned
 * confirmed:true unconditionally even when the native deny-all push failed.
 */
function fakeCdp(opts: { freezeFails?: boolean } = {}): CdpClient {
  return {
    evm: {
      createAccount: async () => ({ address: "0x000000000000000000000000000000000000c0de" }),
      updateAccount: async () => ({ accountPolicy: "pol_deny" }),
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
