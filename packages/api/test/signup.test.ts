import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { asAgentId } from "@countersign/core";
import { MockProvider } from "@countersign/provider-mock";
import {
  CountersignCore,
  TenantRegistry,
  InMemoryKeyStore,
  createCountersignServer,
  type CountersignServer,
} from "@countersign/api";

// One isolated mock-fleet Core per tenant (so a freshly-minted key has agents to govern).
async function tenantFactory(tid: string): Promise<CountersignCore> {
  const core = new CountersignCore();
  await core.registerProvider(new MockProvider({ id: "coinbase", mode: "native-session-caps" }));
  await core.provisionAgent("coinbase", asAgentId(`${tid}-bot`), "base-sepolia");
  return core;
}

describe("self-serve signup (instant-key onboarding)", () => {
  let server: CountersignServer;
  let base: string;

  beforeAll(async () => {
    const registry = new TenantRegistry(tenantFactory);
    server = createCountersignServer(registry.resolver(), {
      apiKeys: { "admin-key": { tenant: "default", role: "admin" } },
      keyStore: new InMemoryKeyStore(),
      signup: { enabled: true, maxPerWindow: 50 },
      publicUrl: "https://app.countersign.network",
    });
    base = `http://localhost:${await server.listen(0)}`;
  });
  afterAll(async () => { await server.close(); });

  it("POST /signup mints a key + a ready-to-paste MCP config", async () => {
    const r = await fetch(`${base}/signup`, { method: "POST" });
    expect(r.status).toBe(200);
    const d = await r.json();
    expect(d.apiKey).toMatch(/^csk_/);
    expect(d.tenant).toMatch(/^t_/);
    const env = d.mcp.mcpServers.countersign.env;
    expect(env.COUNTERSIGN_API_KEY).toBe(d.apiKey);
    expect(env.COUNTERSIGN_URL).toBe("https://app.countersign.network");
  });

  it("the minted key authenticates and routes to its OWN isolated tenant", async () => {
    const { apiKey, tenant } = await (await fetch(`${base}/signup`, { method: "POST" })).json();
    const res = await fetch(`${base}/agents`, { headers: { authorization: `Bearer ${apiKey}` } });
    expect(res.status).toBe(200);
    expect(res.headers.get("x-countersign-tenant")).toBe(tenant);
    const { agents } = await res.json();
    expect(agents.some((a: { agentId: string }) => a.agentId === `${tenant}-bot`)).toBe(true);
  });

  it("no key / unknown key is 401; the static admin key still works (coexist)", async () => {
    expect((await fetch(`${base}/agents`)).status).toBe(401);
    expect((await fetch(`${base}/agents`, { headers: { authorization: "Bearer nope" } })).status).toBe(401);
    const admin = await fetch(`${base}/agents`, { headers: { authorization: "Bearer admin-key" } });
    expect(admin.status).toBe(200);
    expect(admin.headers.get("x-countersign-tenant")).toBe("default");
  });

  it("GET /start serves the get-key page (open)", async () => {
    const r = await fetch(`${base}/start`);
    expect(r.status).toBe(200);
    expect(await r.text()).toMatch(/Get your Countersign key/i);
  });
});

describe("TenantRegistry LRU cap (bounds self-serve memory/DoS)", () => {
  it("evicts the least-recently-used Core beyond maxLive", async () => {
    const reg = new TenantRegistry(async () => new CountersignCore(), { maxLive: 2 });
    await reg.coreFor("a");
    await reg.coreFor("b");
    await reg.coreFor("c"); // over cap → evict oldest (a)
    expect(reg.tenants().sort()).toEqual(["b", "c"]);
  });

  it("a cache hit refreshes recency so it survives the next eviction", async () => {
    const reg = new TenantRegistry(async () => new CountersignCore(), { maxLive: 2 });
    await reg.coreFor("a");
    await reg.coreFor("b");
    await reg.coreFor("a"); // touch a → now most-recent
    await reg.coreFor("c"); // evict oldest, which is now b
    expect(reg.tenants().sort()).toEqual(["a", "c"]);
  });
});

describe("signup disabled", () => {
  it("POST /signup is 404 when not enabled", async () => {
    const s = createCountersignServer(new CountersignCore(), {
      apiKeys: { k: { tenant: "default", role: "operator" } },
      keyStore: new InMemoryKeyStore(),
    });
    const b = `http://localhost:${await s.listen(0)}`;
    expect((await fetch(`${b}/signup`, { method: "POST" })).status).toBe(404);
    await s.close();
  });
});
