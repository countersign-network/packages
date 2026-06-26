/**
 * Builds the demo fleet: three reference agents, one per backend (one per EnforcementMode), each on
 * a different venue — the exact shape the headline demo proves. Mock-backed, so it needs no creds.
 */

import { asAgentId, type AgentId } from "@countersign/core";
import { MockProvider, type MockScenario } from "@countersign/provider-mock";
import { CountersignCore } from "@countersign/api";

export interface FleetMember {
  id: string;
  mode: "native-session-caps" | "pre-sign-policy" | "onchain-policy";
  venue: string;
  label: string;
  agentId: AgentId;
  provider: MockProvider;
}

const SPECS: Omit<FleetMember, "agentId" | "provider">[] = [
  { id: "coinbase", mode: "native-session-caps", venue: "base-sepolia", label: "payments-bot" },
  { id: "turnkey", mode: "pre-sign-policy", venue: "ethereum-sepolia", label: "trading-bot" },
  { id: "openfort", mode: "onchain-policy", venue: "polygon-amoy", label: "ops-bot" },
];

export async function buildMockFleet(opts?: {
  scenarios?: Partial<Record<string, MockScenario>>;
  freezeTimeoutMs?: number;
  escalateTimeoutMs?: number;
}): Promise<{ core: CountersignCore; members: FleetMember[] }> {
  const core = new CountersignCore({
    ...(opts?.freezeTimeoutMs !== undefined ? { freezeTimeoutMs: opts.freezeTimeoutMs } : {}),
    ...(opts?.escalateTimeoutMs !== undefined ? { escalateTimeoutMs: opts.escalateTimeoutMs } : {}),
  });
  const members: FleetMember[] = [];
  for (const s of SPECS) {
    const scenario = opts?.scenarios?.[s.id];
    const provider = new MockProvider({ id: s.id, mode: s.mode, ...(scenario ? { scenario } : {}) });
    await core.registerProvider(provider);
    const agentId = asAgentId(s.label);
    await core.provisionAgent(s.id, agentId, s.venue);
    members.push({ ...s, agentId, provider });
  }
  return { core, members };
}
