/**
 * Cosign as MCP tools — the agent-facing front door. Drop this server into any MCP client (Claude
 * Desktop/Code, etc.) and an operator governs their whole multi-vendor agent fleet from chat:
 * apply a policy, see every spend, and hit the kill switch — plus the agent-side pre-flight guard.
 *
 * Tools are plain data (name + zod schema + async handler returning text) so they're unit-tested
 * directly against a live Core; server.ts is just the stdio wiring around them.
 */

import { z, type ZodRawShape } from "zod";
import { definePolicy } from "@cosign/policy";
import type { CosignApi } from "@cosign/api-contract";

export interface CosignTool {
  name: string;
  description: string;
  schema: ZodRawShape;
  handler: (args: Record<string, unknown>) => Promise<string>;
}

const str = (v: unknown): string | undefined => (typeof v === "string" ? v : v === undefined ? undefined : String(v));
const strArr = (v: unknown): string[] | undefined => (Array.isArray(v) ? v.map((x) => String(x)) : undefined);

export function createCosignTools(client: CosignApi): CosignTool[] {
  return [
    {
      name: "cosign_health",
      description: "Liveness + per-backend health of the Cosign control plane.",
      schema: {},
      handler: async () => {
        const h = await client.health();
        return `Cosign ${h.ok ? "OK" : "DEGRADED"} — ${h.providers
          .map((p) => `${p.id} (${p.mode}): ${p.healthy ? "healthy" : "DOWN"}`)
          .join("; ")}`;
      },
    },
    {
      name: "cosign_list_agents",
      description: "List every governed agent across all wallet backends.",
      schema: {},
      handler: async () => {
        const { agents } = await client.agents();
        if (agents.length === 0) return "No agents provisioned.";
        return `${agents.length} agents:\n` + agents.map((a) => `• ${a.agentId} — ${a.providerId} (${a.mode}) on ${a.venue}`).join("\n");
      },
    },
    {
      name: "cosign_apply_policy",
      description:
        "Compile and apply ONE unified spending policy across every backend (fail-closed). Amounts are base units (USDC has 6 decimals: 100 USDC = 100000000). Omit agentId to apply to all agents.",
      schema: {
        asset: z.string().describe("e.g. USDC"),
        perTxCap: z.string().optional().describe("max per transaction, base units"),
        dailyCap: z.string().optional().describe("max per rolling day, base units"),
        allowlist: z.array(z.string()).optional().describe("permitted counterparties; [] = deny all"),
        denylist: z.array(z.string()).optional(),
        approvalThreshold: z.string().optional().describe("spends strictly above this need human approval"),
        frozen: z.boolean().optional().describe("hard kill — deny everything"),
        venues: z.array(z.string()).optional(),
        agentId: z.string().optional(),
      },
      handler: async (args) => {
        const policy = definePolicy({
          asset: String(args["asset"]),
          ...(str(args["perTxCap"]) !== undefined ? { perTxCap: str(args["perTxCap"])! } : {}),
          ...(str(args["dailyCap"]) !== undefined ? { dailyCap: str(args["dailyCap"])! } : {}),
          ...(strArr(args["allowlist"]) !== undefined ? { allowlist: strArr(args["allowlist"])! } : {}),
          ...(strArr(args["denylist"]) !== undefined ? { denylist: strArr(args["denylist"])! } : {}),
          ...(str(args["approvalThreshold"]) !== undefined ? { approvalThreshold: str(args["approvalThreshold"])! } : {}),
          ...(typeof args["frozen"] === "boolean" ? { frozen: args["frozen"] } : {}),
          ...(strArr(args["venues"]) !== undefined ? { venues: strArr(args["venues"])! } : {}),
        });
        const agentId = str(args["agentId"]);
        const res = await client.applyPolicy({ policy, ...(agentId !== undefined ? { agentId } : {}) });
        const failed = res.failed.length > 0 ? ` ${res.failed.length} FAILED (fail-closed — not live): ${res.failed.map((f) => f.providerId).join(", ")}.` : "";
        return `Applied to ${res.applied.length} backend agent(s).${failed}`;
      },
    },
    {
      name: "cosign_request_spend",
      description:
        "Pre-flight guard for an agent: ask Cosign whether a spend is allowed BEFORE touching the wallet. Returns allow / deny / needs_approval. Amount in base units.",
      schema: {
        agentId: z.string(),
        amount: z.string(),
        asset: z.string(),
        counterparty: z.string().optional(),
        venue: z.string(),
      },
      handler: async (args) => {
        const cp = str(args["counterparty"]);
        const d = await client.evaluate({
          agentId: String(args["agentId"]),
          amount: String(args["amount"]),
          asset: String(args["asset"]),
          venue: String(args["venue"]),
          ...(cp !== undefined ? { counterparty: cp } : {}),
        });
        return `${d.outcome.toUpperCase()}${d.reason ? `: ${d.reason}` : ""}${d.approvalToken ? ` (approvalToken ${d.approvalToken})` : ""}`;
      },
    },
    {
      name: "cosign_freeze",
      description: "THE KILL SWITCH. Freeze every agent on every backend at once, in under a second.",
      schema: { reason: z.string().optional() },
      handler: async (args) => {
        const r = await client.freeze({ ...(str(args["reason"]) !== undefined ? { reason: str(args["reason"])! } : {}) });
        return `FREEZE: all ${r.providers.length} backends stopped=${r.allStopped} in ${r.windowMs}ms.\n` +
          r.providers.map((p) => `  ${p.providerId} (${p.mode}): ${p.outcome}${p.mechanism ? ` via ${p.mechanism}` : ""}`).join("\n");
      },
    },
    {
      name: "cosign_unfreeze",
      description: "Lift a freeze across every backend (recover / replay).",
      schema: {},
      handler: async () => {
        await client.unfreeze();
        return "Unfrozen — agents may spend again within policy.";
      },
    },
    {
      name: "cosign_ledger",
      description: "Read the append-only, hash-chained audit ledger (every attempt, everywhere) and re-verify its integrity.",
      schema: { limit: z.number().optional().describe("how many recent entries to show (default 15)") },
      handler: async (args) => {
        const { records, verified } = await client.ledger();
        const limit = typeof args["limit"] === "number" ? (args["limit"] as number) : 15;
        const recent = records.slice(-limit);
        const body = recent.map((r) => `#${r.index} ${r.payload.kind}`).join("\n");
        return `Ledger: ${records.length} entries, hash-chain ${verified ? "✓ INTACT" : "✗ TAMPERED"}.\n${body}`;
      },
    },
  ];
}
