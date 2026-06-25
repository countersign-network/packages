/**
 * In-process front door. `createLocalApi` wraps a CosignCore so it satisfies the same `CosignApi`
 * the HTTP client implements — letting the MCP server (and anything else) run an EMBEDDED Core with
 * zero network setup. `createDemoCore` is the shared mock-fleet setup used by the runnable server
 * and by embedded mode, so "one command, no config" works everywhere.
 */

import { asAgentId, type AgentId, type EnforcementMode, type LedgerEvent } from "@cosign/core";
import { definePolicy } from "@cosign/policy";
import { MockProvider } from "@cosign/provider-mock";
import type { LedgerPort } from "@cosign/ledger";
import type { AgentDTO, CosignApi } from "@cosign/api-contract";
import { CosignCore } from "./core-service";

export function createLocalApi(core: CosignCore): CosignApi {
  return {
    async health() {
      const providers = await core.health();
      return { ok: providers.every((p) => p.healthy), providers };
    },
    async agents() {
      return {
        agents: core.agents().map((a): AgentDTO => ({
          providerId: a.provider,
          agentId: a.agentId,
          wallet: a.wallet,
          venue: a.venue,
          mode: core.modeOf(a.provider) as EnforcementMode,
        })),
      };
    },
    applyPolicy(req) {
      return core.applyPolicy(req.policy, req.agentId ? asAgentId(req.agentId) : undefined);
    },
    evaluate(req) {
      return core.evaluateSpend(asAgentId(req.agentId), {
        amount: req.amount,
        asset: req.asset,
        venue: req.venue,
        ...(req.counterparty !== undefined ? { counterparty: req.counterparty } : {}),
      });
    },
    async approvals() {
      return core.approvals();
    },
    approve(req) {
      return core.approve(req.approvalToken);
    },
    deny(req) {
      return core.deny(req.approvalToken, req.reason);
    },
    async freeze(req) {
      return core.freezeAll(req?.reason ?? "freeze (embedded)");
    },
    async unfreeze() {
      await core.unfreezeAll();
      return { ok: true };
    },
    async ledger() {
      const records = (await core.ledgerRecords()).map((r) => ({
        index: r.index,
        prevHash: r.prevHash,
        payloadHash: r.payloadHash,
        rowHash: r.rowHash,
        payload: r.payload,
      }));
      const publicKey = core.ledgerPublicKey();
      return { records, verified: await core.verifyLedger(), ...(publicKey ? { publicKey } : {}) };
    },
  };
}

export interface DemoFleetMember {
  id: string;
  mode: EnforcementMode;
  venue: string;
  agentId: AgentId;
  provider: MockProvider;
}

/** Build a ready-to-use Core over the standard 3-backend mock fleet (one per enforcement mode). */
export async function createDemoCore(opts?: {
  applyDefaultPolicy?: boolean;
  ledger?: LedgerPort<LedgerEvent>;
}): Promise<{ core: CosignCore; fleet: DemoFleetMember[] }> {
  const core = new CosignCore(opts?.ledger ? { ledger: opts.ledger } : {});
  const specs: { id: string; mode: EnforcementMode; venue: string; label: string }[] = [
    { id: "coinbase", mode: "native-session-caps", venue: "base-sepolia", label: "payments-bot" },
    { id: "turnkey", mode: "pre-sign-policy", venue: "ethereum-sepolia", label: "trading-bot" },
    { id: "openfort", mode: "onchain-policy", venue: "polygon-amoy", label: "ops-bot" },
  ];
  const fleet: DemoFleetMember[] = [];
  for (const s of specs) {
    const provider = new MockProvider({ id: s.id, mode: s.mode });
    await core.registerProvider(provider);
    const agentId = asAgentId(s.label);
    await core.provisionAgent(s.id, agentId, s.venue);
    fleet.push({ id: s.id, mode: s.mode, venue: s.venue, agentId, provider });
  }
  if (opts?.applyDefaultPolicy !== false) {
    await core.applyPolicy(
      definePolicy({ asset: "USDC", perTxCap: "100000000", dailyCap: "100000000000", allowlist: ["0xTREASURY"] }),
    );
  }
  return { core, fleet };
}
