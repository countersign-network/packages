import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { asAgentId } from "@countersign/core";
import { definePolicy } from "@countersign/policy";
import { MockProvider } from "@countersign/provider-mock";
import { CountersignCore, createCountersignServer, type CountersignServer } from "@countersign/api";
import { CountersignClient, CountersignApiError, type WsServerMessage } from "@countersign/sdk";

let server: CountersignServer;
let client: CountersignClient;

beforeAll(async () => {
  const core = new CountersignCore({ freezeTimeoutMs: 300, escalateTimeoutMs: 300 });
  const fleet = [
    { id: "coinbase", mode: "native-session-caps" as const, venue: "base-sepolia" },
    { id: "turnkey", mode: "pre-sign-policy" as const, venue: "ethereum-sepolia" },
    { id: "openfort", mode: "onchain-policy" as const, venue: "polygon-amoy" },
  ];
  for (const f of fleet) {
    await core.registerProvider(new MockProvider({ id: f.id, mode: f.mode }));
    await core.provisionAgent(f.id, asAgentId(`${f.id}-agent`), f.venue);
  }
  server = createCountersignServer(core);
  const port = await server.listen(0);
  client = new CountersignClient({ baseUrl: `http://localhost:${port}` });
});

afterAll(async () => {
  await server.close();
});

describe("@countersign/sdk — typed client over the Core API", () => {
  it("health() lists the backends", async () => {
    const h = await client.health();
    expect(h.ok).toBe(true);
    expect(h.providers).toHaveLength(3);
  });

  it("applyPolicy() -> agents() -> freeze() -> ledger() round-trips", async () => {
    const applied = await client.applyPolicy({ policy: definePolicy({ asset: "USDC", perTxCap: "100", allowlist: ["0x000000000000000000000000000000000000dEaD"] }) });
    expect(applied.applied).toHaveLength(3);
    expect((await client.agents()).agents).toHaveLength(3);

    const report = await client.freeze({ reason: "sdk test" });
    expect(report.allStopped).toBe(true);
    expect(report.windowMs).toBeLessThan(1000);

    const ledger = await client.ledger();
    expect(ledger.verified).toBe(true);
    expect(ledger.records.length).toBeGreaterThan(0);

    expect((await client.unfreeze()).ok).toBe(true);
  });

  it("subscribe() streams ledger appends triggered by a freeze", async () => {
    const messages: WsServerMessage[] = [];
    const got = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("no ledger_append")), 4000);
      const unsub = client.subscribe((m) => {
        messages.push(m);
        if (m.type === "ledger_append") {
          clearTimeout(timer);
          unsub();
          resolve();
        }
      });
    });
    // small delay so the socket is open before we trigger events
    await new Promise((r) => setTimeout(r, 150));
    await client.freeze({ reason: "stream test" });
    await got;
    expect(messages.some((m) => m.type === "ledger_append")).toBe(true);
  });

  it("approval workflow round-trips over HTTP (evaluate -> approvals -> approve)", async () => {
    await client.unfreeze(); // earlier tests left the shared Core frozen
    await client.applyPolicy({ policy: definePolicy({ asset: "USDC", perTxCap: "100000000", allowlist: ["0x000000000000000000000000000000000000dEaD"], approvalThreshold: "60000000" }) });
    const d = await client.evaluate({ agentId: "coinbase-agent", amount: "80000000", asset: "USDC", counterparty: "0x000000000000000000000000000000000000dEaD", venue: "base-sepolia" });
    expect(d.outcome).toBe("needs_approval");
    expect((await client.approvals()).approvals.length).toBeGreaterThan(0);
    const r = await client.approve({ approvalToken: d.approvalToken! });
    expect(r.outcome).toBe("approved");
  });

  it("surfaces non-2xx responses as CountersignApiError", async () => {
    const failing = new CountersignClient({
      baseUrl: "http://example.invalid",
      fetch: async () => new Response("boom", { status: 500 }),
    });
    await expect(failing.health()).rejects.toBeInstanceOf(CountersignApiError);
  });
});
