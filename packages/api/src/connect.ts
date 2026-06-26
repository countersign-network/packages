/**
 * The moat-validation demo layer. Cosign's entire thesis is cross-vendor AGGREGATION — holding the
 * policy, freeze, and ledger across MORE THAN ONE wallet backend at once, which no single vendor can
 * do. The one assumption that makes or breaks it: do operators connect a SECOND backend? So this
 * turns "connect a backend" into the headline action and instruments the second-backend connect.
 *
 * Backends here are mock-backed (no creds, instant, safe to host) — the SAME control plane runs the
 * real three-vendor freeze in packages/agent-harness/live-freeze.ts.
 */

import { asAgentId, type EnforcementMode } from "@cosign/core";
import { definePolicy } from "@cosign/policy";
import { MockProvider } from "@cosign/provider-mock";
import type { CosignCore } from "./core-service";

export interface BackendSpec {
  id: string;
  label: string;
  mode: EnforcementMode;
  venue: string;
  blurb: string;
}

/** The connectable backends — one per enforcement mode, mirroring the three live adapters. */
export const BACKEND_CATALOG: BackendSpec[] = [
  { id: "coinbase", label: "Coinbase", mode: "native-session-caps", venue: "base-sepolia", blurb: "MPC session caps" },
  { id: "turnkey", label: "Turnkey", mode: "pre-sign-policy", venue: "ethereum-sepolia", blurb: "Pre-sign CEL policy" },
  { id: "openfort", label: "Openfort", mode: "onchain-policy", venue: "polygon-amoy", blurb: "On-chain session keys" },
];

interface MoatState {
  /** When each backend was first connected — order + timing is the metric we care about. */
  connectOrder: { id: string; at: number }[];
  freezeCount: number;
  lastFreezeWindowMs: number | undefined;
}

const states = new WeakMap<CosignCore, MoatState>();
function stateOf(core: CosignCore): MoatState {
  let s = states.get(core);
  if (!s) {
    s = { connectOrder: [], freezeCount: 0, lastFreezeWindowMs: undefined };
    states.set(core, s);
  }
  return s;
}

export interface MoatMetrics {
  connectedCount: number;
  /** THE moat metric: did this operator connect a second backend, and how fast? */
  multiBackend: boolean;
  secondBackendConnectedAt: number | undefined;
  /** ms between the first and second connect (the "aha" latency). */
  timeToSecondBackendMs: number | undefined;
  connectOrder: { id: string; at: number }[];
  freezeCount: number;
  lastFreezeWindowMs: number | undefined;
}

export function metricsOf(core: CosignCore): MoatMetrics {
  const s = stateOf(core);
  const first = s.connectOrder[0];
  const second = s.connectOrder[1];
  return {
    connectedCount: connectedIds(core).size,
    multiBackend: connectedIds(core).size >= 2,
    secondBackendConnectedAt: second?.at,
    timeToSecondBackendMs: first && second ? second.at - first.at : undefined,
    connectOrder: s.connectOrder,
    freezeCount: s.freezeCount,
    lastFreezeWindowMs: s.lastFreezeWindowMs,
  };
}

function connectedIds(core: CosignCore): Set<string> {
  return new Set(core.agents().map((a) => String(a.provider)));
}

export interface BackendsView {
  backends: (BackendSpec & { connected: boolean })[];
  metrics: MoatMetrics;
}

export function backendsView(core: CosignCore): BackendsView {
  const connected = connectedIds(core);
  return {
    backends: BACKEND_CATALOG.map((b) => ({ ...b, connected: connected.has(b.id) })),
    metrics: metricsOf(core),
  };
}

/**
 * Tap-to-connect a backend: lazily register its (mock) adapter, provision an agent, and apply the
 * shared unified policy so the freeze has something to govern. Idempotent per backend. `nowMs` is
 * injectable for deterministic tests.
 */
export async function connectBackend(core: CosignCore, providerId: string, nowMs: () => number = Date.now): Promise<BackendsView> {
  const spec = BACKEND_CATALOG.find((b) => b.id === providerId);
  if (!spec) throw new Error(`unknown backend: ${providerId}`);

  if (!connectedIds(core).has(spec.id)) {
    if (!core.hasProvider(spec.id)) await core.registerProvider(new MockProvider({ id: spec.id, mode: spec.mode }));
    await core.provisionAgent(spec.id, asAgentId(`${spec.id}-agent`), spec.venue);
    // One unified policy, compiled to each backend's native controls (re-applied across all agents).
    await core.applyPolicy(definePolicy({ asset: "USDC", perTxCap: "100000000", allowlist: ["0xTREASURY"] }));
    stateOf(core).connectOrder.push({ id: spec.id, at: nowMs() });
  }
  return backendsView(core);
}

/** Record a freeze into the moat metrics (called after a successful freezeAll). */
export function recordFreeze(core: CosignCore, windowMs: number): void {
  const s = stateOf(core);
  s.freezeCount += 1;
  s.lastFreezeWindowMs = windowMs;
}
