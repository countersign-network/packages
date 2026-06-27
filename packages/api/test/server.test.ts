import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { asAgentId } from "@countersign/core";
import { definePolicy } from "@countersign/policy";
import { MockProvider } from "@countersign/provider-mock";
import { CountersignCore, TenantRegistry, createCountersignServer, type CountersignServer } from "@countersign/api";
import type { AgentsResponse, HealthResponse, LedgerResponse, WsServerMessage } from "@countersign/api-contract";
import type { FreezeReport } from "@countersign/core";

let server: CountersignServer;
let base: string;
let wsUrl: string;

/** Resolve with the ws close code (for unauthorized-handshake assertions). */
function wsClosed(url: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const timer = setTimeout(() => reject(new Error("ws neither closed nor messaged")), 4000);
    ws.addEventListener("close", (ev) => { clearTimeout(timer); resolve((ev as CloseEvent).code); });
    ws.addEventListener("message", () => { clearTimeout(timer); ws.close(); reject(new Error("expected close, got a message")); });
  });
}
/** Resolve with the type of the first ws message (for authorized-handshake assertions). */
function wsFirstType(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const timer = setTimeout(() => reject(new Error("no ws message")), 4000);
    ws.addEventListener("message", (ev) => { clearTimeout(timer); const m = JSON.parse(String((ev as MessageEvent).data)); ws.close(); resolve(m.type); });
    ws.addEventListener("close", () => { clearTimeout(timer); reject(new Error("ws closed before any message")); });
  });
}

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
  base = `http://localhost:${port}`;
  wsUrl = `ws://localhost:${port}/events`;
});

afterAll(async () => {
  await server.close();
});

describe("Countersign Core server (REST + ws)", () => {
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
      body: JSON.stringify({ policy: definePolicy({ asset: "USDC", perTxCap: "100", allowlist: ["0x000000000000000000000000000000000000dEaD"] }) }),
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

describe("API auth + RBAC + tenant seam", () => {
  let authServer: CountersignServer;
  let authBase: string;
  const opKey = { authorization: "Bearer op-key" };
  const viewKey = { authorization: "Bearer view-key" };

  beforeAll(async () => {
    const core = new CountersignCore();
    await core.registerProvider(new MockProvider({ id: "coinbase", mode: "native-session-caps" }));
    await core.provisionAgent("coinbase", asAgentId("a"), "base-sepolia");
    authServer = createCountersignServer(core, {
      apiKeys: { "op-key": { tenant: "acme", role: "operator" }, "view-key": { tenant: "acme", role: "viewer" } },
    });
    authBase = `http://localhost:${await authServer.listen(0)}`;
  });

  afterAll(async () => {
    await authServer.close();
  });

  it("GET /health stays open (liveness needs no key)", async () => {
    expect((await fetch(`${authBase}/health`)).status).toBe(200);
  });

  it("no key / wrong key is 401", async () => {
    expect((await fetch(`${authBase}/agents`)).status).toBe(401);
    expect((await fetch(`${authBase}/agents`, { headers: { authorization: "Bearer nope" } })).status).toBe(401);
  });

  it("a valid key passes and resolves the tenant", async () => {
    const res = await fetch(`${authBase}/agents`, { headers: opKey });
    expect(res.status).toBe(200);
    expect(res.headers.get("x-countersign-tenant")).toBe("acme");
  });

  it("RBAC: viewer can read but cannot freeze (403); operator can", async () => {
    expect((await fetch(`${authBase}/agents`, { headers: viewKey })).status).toBe(200); // read ok
    expect((await fetch(`${authBase}/freeze`, { method: "POST", headers: viewKey })).status).toBe(403); // write denied
    expect((await fetch(`${authBase}/freeze`, { method: "POST", headers: opKey })).status).toBe(200); // operator ok
  });

  it("ws needs a single-use ticket — a raw key in the URL never authenticates the stream", async () => {
    const wsBase = authBase.replace(/^http/, "ws");
    // No ticket, a bogus ticket, and even the real key as ?key= are all rejected (1008).
    expect(await wsClosed(`${wsBase}/events`)).toBe(1008);
    expect(await wsClosed(`${wsBase}/events?ticket=nope`)).toBe(1008);
    expect(await wsClosed(`${wsBase}/events?key=view-key`)).toBe(1008);
  });

  it("POST /ws-ticket: needs a valid key, then yields a one-shot ticket that opens the stream", async () => {
    expect((await fetch(`${authBase}/ws-ticket`, { method: "POST" })).status).toBe(401); // no key
    const { ticket } = await (await fetch(`${authBase}/ws-ticket`, { method: "POST", headers: viewKey })).json(); // viewer is enough (read-only stream)
    expect(typeof ticket).toBe("string");
    const wsBase = authBase.replace(/^http/, "ws");
    expect(await wsFirstType(`${wsBase}/events?ticket=${ticket}`)).toBe("hello"); // first use connects
    expect(await wsClosed(`${wsBase}/events?ticket=${ticket}`)).toBe(1008); // reuse rejected (single-use)
  });

  it("RBAC: the connect-demo routes are gated — /connect is operator+, /backends is viewer+", async () => {
    const connect = (h: Record<string, string>) =>
      fetch(`${authBase}/connect`, { method: "POST", headers: { ...h, "content-type": "application/json" }, body: JSON.stringify({ providerId: "coinbase" }) });
    expect((await connect({})).status).toBe(401); // no key
    expect((await connect(viewKey)).status).toBe(403); // viewer can't connect (it's a write)
    expect((await connect(opKey)).status).toBe(200); // operator can
    expect((await fetch(`${authBase}/backends`, { headers: viewKey })).status).toBe(200); // read ok for viewer
    expect((await fetch(`${authBase}/backends`)).status).toBe(401); // but still needs a key
  });
});

describe("rate limiting on mutating routes", () => {
  let rlServer: CountersignServer;
  let rlBase: string;

  beforeAll(async () => {
    const core = new CountersignCore();
    await core.registerProvider(new MockProvider({ id: "coinbase", mode: "native-session-caps" }));
    rlServer = createCountersignServer(core, { rateLimit: { windowMs: 60_000, max: 2 } });
    rlBase = `http://localhost:${await rlServer.listen(0)}`;
  });

  afterAll(async () => {
    await rlServer.close();
  });

  it("allows up to the limit, then returns 429 with Retry-After", async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 3; i++) statuses.push((await fetch(`${rlBase}/freeze`, { method: "POST" })).status);
    expect(statuses).toEqual([200, 200, 429]);
    const blocked = await fetch(`${rlBase}/freeze`, { method: "POST" });
    expect(blocked.headers.get("retry-after")).toBeTruthy();
  });

  it("does not rate-limit reads", async () => {
    for (let i = 0; i < 5; i++) expect((await fetch(`${rlBase}/health`)).status).toBe(200);
  });
});

describe("multi-tenancy (one isolated Core per tenant)", () => {
  let mtServer: CountersignServer;
  let mtBase: string;
  const acme = { authorization: "Bearer acme-key" };
  const globex = { authorization: "Bearer globex-key" };

  beforeAll(async () => {
    // A Core per tenant, each with its own provider + a tenant-named agent + its own ledger.
    const registry = new TenantRegistry(async (tenantId) => {
      const core = new CountersignCore();
      await core.registerProvider(new MockProvider({ id: "coinbase", mode: "native-session-caps" }));
      await core.provisionAgent("coinbase", asAgentId(`${tenantId}-bot`), "base-sepolia");
      return core;
    });
    mtServer = createCountersignServer(registry.resolver(), {
      apiKeys: { "acme-key": { tenant: "acme", role: "operator" }, "globex-key": { tenant: "globex", role: "operator" } },
    });
    mtBase = `http://localhost:${await mtServer.listen(0)}`;
  });

  afterAll(async () => {
    await mtServer.close();
  });

  it("each tenant sees only its own agents", async () => {
    const a = (await (await fetch(`${mtBase}/agents`, { headers: acme })).json()) as AgentsResponse;
    const g = (await (await fetch(`${mtBase}/agents`, { headers: globex })).json()) as AgentsResponse;
    expect(a.agents.map((x) => x.agentId)).toEqual(["acme-bot"]);
    expect(g.agents.map((x) => x.agentId)).toEqual(["globex-bot"]);
  });

  it("freezing one tenant does not touch another (isolated ledgers)", async () => {
    await fetch(`${mtBase}/freeze`, { method: "POST", headers: acme });
    const aLedger = (await (await fetch(`${mtBase}/ledger`, { headers: acme })).json()) as LedgerResponse;
    const gLedger = (await (await fetch(`${mtBase}/ledger`, { headers: globex })).json()) as LedgerResponse;
    expect(aLedger.records.some((r) => r.payload.kind === "freeze_requested")).toBe(true);
    expect(gLedger.records.some((r) => r.payload.kind === "freeze_requested")).toBe(false);
  });
});
