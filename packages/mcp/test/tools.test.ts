import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { asAgentId } from "@countersign/core";
import { MockProvider } from "@countersign/provider-mock";
import { CountersignCore, createCountersignServer, type CountersignServer } from "@countersign/api";
import { CountersignClient } from "@countersign/sdk";
import { createCountersignTools, type CountersignTool } from "@countersign/mcp";

let server: CountersignServer;
let tools: Map<string, CountersignTool>;

const call = (name: string, args: Record<string, unknown> = {}) => tools.get(name)!.handler(args);

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
  const client = new CountersignClient({ baseUrl: `http://localhost:${port}` });
  tools = new Map(createCountersignTools(client).map((t) => [t.name, t]));
});

afterAll(async () => {
  await server.close();
});

describe("@countersign/mcp — Countersign as MCP tools", () => {
  it("exposes the operator + agent tool set", () => {
    for (const name of [
      "countersign_health",
      "countersign_list_agents",
      "countersign_apply_policy",
      "countersign_request_spend",
      "countersign_freeze",
      "countersign_unfreeze",
      "countersign_ledger",
    ]) {
      expect(tools.has(name)).toBe(true);
    }
  });

  it("health + list_agents report the fleet", async () => {
    expect(await call("countersign_health")).toContain("coinbase");
    expect(await call("countersign_list_agents")).toContain("openfort-agent");
  });

  it("apply_policy then request_spend guards correctly (allow / deny)", async () => {
    expect(await call("countersign_apply_policy", { asset: "USDC", perTxCap: "100", allowlist: ["0x000000000000000000000000000000000000dEaD"] })).toContain("Applied to 3");

    const ok = await call("countersign_request_spend", { agentId: "coinbase-agent", amount: "50", asset: "USDC", counterparty: "0x000000000000000000000000000000000000dEaD", venue: "base-sepolia" });
    expect(ok).toContain("ALLOW");

    const overCap = await call("countersign_request_spend", { agentId: "coinbase-agent", amount: "500", asset: "USDC", counterparty: "0x000000000000000000000000000000000000dEaD", venue: "base-sepolia" });
    expect(overCap).toContain("DENY");

    const stranger = await call("countersign_request_spend", { agentId: "coinbase-agent", amount: "1", asset: "USDC", counterparty: "0x0000000000000000000000000000000000005a7a", venue: "base-sepolia" });
    expect(stranger).toContain("DENY");
  });

  it("approval tools: a spend needing approval can be listed and approved from chat", async () => {
    await call("countersign_apply_policy", { asset: "USDC", perTxCap: "100000000", allowlist: ["0x000000000000000000000000000000000000dEaD"], approvalThreshold: "60000000" });
    const res = await call("countersign_request_spend", { agentId: "coinbase-agent", amount: "80000000", asset: "USDC", counterparty: "0x000000000000000000000000000000000000dEaD", venue: "base-sepolia" });
    expect(res).toContain("NEEDS_APPROVAL");
    const token = res.match(/approvalToken (\S+)\)/)?.[1];
    expect(token).toBeTruthy();
    expect(await call("countersign_list_approvals")).toContain(token!);
    expect(await call("countersign_approve", { approvalToken: token })).toContain("APPROVED");
  });

  it("the freeze tool is the kill switch, and the ledger verifies", async () => {
    const frozen = await call("countersign_freeze", { reason: "mcp test" });
    expect(frozen).toContain("stopped=true");

    const ledger = await call("countersign_ledger", { limit: 50 });
    expect(ledger).toContain("INTACT");
    expect(ledger).toContain("freeze_resolved");

    expect(await call("countersign_unfreeze")).toContain("Unfrozen");
  });
});
