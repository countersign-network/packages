import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { asAgentId } from "@cosign/core";
import { definePolicy } from "@cosign/policy";
import { MockProvider } from "@cosign/provider-mock";
import { CosignCore, createCosignServer, type CosignServer } from "@cosign/api";
import type { AgentsResponse, HealthResponse, LedgerResponse, WsServerMessage } from "@cosign/api-contract";
import type { FreezeReport } from "@cosign/core";

let server: CosignServer;
let base: string;
let wsUrl: string;

beforeAll(async () => {
  const core = new CosignCore({ freezeTimeoutMs: 300, escalateTimeoutMs: 300 });
  const fleet = [
    { id: "coinbase", mode: "native-session-caps" as const, venue: "base-sepolia" },
    { id: "turnkey", mode: "pre-sign-policy" as const, venue: "ethereum-sepolia" },
    { id: "openfort", mode: "onchain-policy" as const, venue: "polygon-amoy" },
  ];
  for (const f of fleet) {
    await core.registerProvider(new MockProvider({ id: f.id, mode: f.mode }));
    await core.provisionAgent(f.id, asAgentId(`${f.id}-agent`), f.venue);
  }
  server = createCosignServer(core);
  const port = await server.listen(0);
  base = `http://localhost:${port}`;
  wsUrl = `ws://localhost:${port}/events`;
});

afterAll(async () => {
  await server.close();
});

describe("Cosign Core server (REST + ws)", () => {
  it("GET /health reports all three backends", async () => {
    const body = (await (await fetch(`${base}/health`)).json()) as HealthResponse;
    expect(body.providers).toHaveLength(3);
    expect(body.providers.map((p) => p.mode).sort()).toEqual(["native-session-caps", "onchain-policy", "pre-sign-policy"]);
  });

  it("GET /agents lists provisioned agents", async () => {
    const body = (await (await fetch(`${base}/agents`)).json()) as AgentsResponse;
    expect(body.agents).toHaveLength(3);
  });

  it("POST /policy applies across all backends", async () => {
    const res = await fetch(`${base}/policy`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ policy: definePolicy({ asset: "USDC", perTxCap: "100", allowlist: ["0xTREASURY"] }) }),
    });
    const body = (await res.json()) as { applied: unknown[]; failed: unknown[] };
    expect(body.applied).toHaveLength(3);
    expect(body.failed).toHaveLength(0);
  });

  it("POST /freeze stops everything and returns a sub-second report", async () => {
    const report = (await (await fetch(`${base}/freeze`, { method: "POST" })).json()) as FreezeReport;
    expect(report.allStopped).toBe(true);
    expect(report.windowMs).toBeLessThan(1000);
  });

  it("GET /ledger returns a verified, hash-chained log", async () => {
    const body = (await (await fetch(`${base}/ledger`)).json()) as LedgerResponse;
    expect(body.verified).toBe(true);
    expect(body.records.length).toBeGreaterThan(0);
    expect(body.records[0]!.index).toBe(0);
  });

  it("ws stream sends hello, then pushes ledger appends on a freeze", async () => {
    const messages: WsServerMessage[] = [];
    const ws = new WebSocket(wsUrl);
    const gotAppend = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("no ledger_append within timeout")), 4000);
      ws.addEventListener("message", (ev) => {
        const msg = JSON.parse(String((ev as MessageEvent).data)) as WsServerMessage;
        messages.push(msg);
        if (msg.type === "ledger_append") {
          clearTimeout(timer);
          resolve();
        }
      });
      ws.addEventListener("error", () => reject(new Error("ws error")));
    });
    await new Promise<void>((resolve) => ws.addEventListener("open", () => resolve()));
    await fetch(`${base}/freeze`, { method: "POST" });
    await gotAppend;
    ws.close();

    expect(messages[0]!.type).toBe("hello");
    expect(messages.some((m) => m.type === "ledger_append")).toBe(true);
  });
});

describe("API auth + tenant seam", () => {
  let authServer: CosignServer;
  let authBase: string;

  beforeAll(async () => {
    const core = new CosignCore();
    await core.registerProvider(new MockProvider({ id: "coinbase", mode: "native-session-caps" }));
    await core.provisionAgent("coinbase", asAgentId("a"), "base-sepolia");
    authServer = createCosignServer(core, { apiKeys: { "test-key-123": "acme" } });
    authBase = `http://localhost:${await authServer.listen(0)}`;
  });

  afterAll(async () => {
    await authServer.close();
  });

  it("GET /health stays open (liveness needs no key)", async () => {
    expect((await fetch(`${authBase}/health`)).status).toBe(200);
  });

  it("a protected route returns 401 without a key", async () => {
    expect((await fetch(`${authBase}/agents`)).status).toBe(401);
    expect((await fetch(`${authBase}/freeze`, { method: "POST" })).status).toBe(401);
  });

  it("a valid key passes and resolves the tenant", async () => {
    const res = await fetch(`${authBase}/agents`, { headers: { authorization: "Bearer test-key-123" } });
    expect(res.status).toBe(200);
    expect(res.headers.get("x-cosign-tenant")).toBe("acme");
  });

  it("a wrong key is rejected", async () => {
    expect((await fetch(`${authBase}/agents`, { headers: { authorization: "Bearer nope" } })).status).toBe(401);
  });
});
