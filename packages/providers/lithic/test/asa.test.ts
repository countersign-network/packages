import { describe, it, expect } from "vitest";
import { asAgentId } from "@countersign/core";
import { definePolicy, type UnifiedPolicy } from "@countersign/policy";
import { LithicProvider, type LithicConfig } from "../src/index";

/**
 * Offline unit test of the Lithic ASA (Authorization Stream Access) real-time decision — no creds; a
 * fake Lithic client is injected by stubbing client(). ASA is what makes dailyCap + approvalThreshold
 * ENFORCED on the card (the static spend_limit only carries a per-tx cap). All amounts are cents.
 */
function stubClient(p: LithicProvider): void {
  (p as unknown as { client: () => unknown }).client = () => ({
    cards: {
      create: async () => ({ token: "card_1", last_four: "4242", state: "OPEN" }),
      update: async (_token: string, body: { state?: string }) => ({ state: body?.state ?? "OPEN" }),
      list: async () => ({ data: [] }),
    },
  });
}

async function setup(policy: UnifiedPolicy, config: LithicConfig = { asaEnabled: true }) {
  const p = new LithicProvider(config);
  stubClient(p);
  const agentId = asAgentId("a");
  await p.provisionWallet(agentId, { venue: "visa" });
  await p.applyPolicy(agentId, policy);
  return { p, agentId };
}

const auth = (amount: string) => ({ cardToken: "card_1", amount });

describe("Lithic ASA real-time decision (fail-closed)", () => {
  it("approves within policy and ENFORCES the rolling daily cap (which the static limit can't)", async () => {
    const { p } = await setup(definePolicy({ asset: "USDC", perTxCap: "100", dailyCap: "150" }));
    expect(p.decideAuthorization(auth("50")).approved).toBe(true); // daily 50
    expect(p.decideAuthorization(auth("60")).approved).toBe(true); // daily 110
    const third = p.decideAuthorization(auth("60")); // 110 + 60 = 170 > 150
    expect(third.approved).toBe(false);
    expect(third.reason).toMatch(/daily cap/i);
  });

  it("declines over the per-transaction cap", async () => {
    const { p } = await setup(definePolicy({ asset: "USDC", perTxCap: "100" }));
    expect(p.decideAuthorization(auth("101")).approved).toBe(false);
    expect(p.decideAuthorization(auth("100")).approved).toBe(true); // exactly at cap is fine
  });

  it("declines over the approval threshold (no inline human approval on a card auth)", async () => {
    const { p } = await setup(definePolicy({ asset: "USDC", perTxCap: "1000", approvalThreshold: "120" }));
    const d = p.decideAuthorization(auth("130"));
    expect(d.approved).toBe(false);
    expect(d.reason).toMatch(/approval threshold/i);
  });

  it("declines every authorization once frozen", async () => {
    const { p } = await setup(definePolicy({ asset: "USDC", perTxCap: "100" }));
    await p.freeze({ kind: "provider-all" });
    const d = p.decideAuthorization(auth("10"));
    expect(d.approved).toBe(false);
    expect(d.reason).toMatch(/frozen/i);
  });

  it("declines an unknown card and a malformed amount (default deny)", async () => {
    const { p } = await setup(definePolicy({ asset: "USDC", perTxCap: "100" }));
    expect(p.decideAuthorization({ cardToken: "card_nope", amount: "10" }).approved).toBe(false);
    expect(p.decideAuthorization(auth("not-a-number")).approved).toBe(false);
  });
});
