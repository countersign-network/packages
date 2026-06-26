/**
 * The moat-validation demo layer. Cosign's entire thesis is cross-vendor AGGREGATION — holding the
 * policy, freeze, and ledger across MORE THAN ONE wallet backend at once, which no single vendor can
 * do. The one assumption that makes or breaks it: do operators connect a SECOND backend? So this
 * turns "connect a backend" into the headline action and instruments the second-backend connect.
 *
 * The metric is DURABLE: every connect is recorded as a `backend_connected` row in the signed,
 * hash-chained ledger (Postgres on the deployed core), and the metrics below are DERIVED from it — so
 * the second-backend connect rate survives restarts and is auditable, not just in-process.
 *
 * Backends here are mock-backed (no creds, instant, safe to host) — the SAME control plane runs the
 * real three-vendor freeze in packages/agent-harness/live-freeze.ts.
 */

import { asAgentId, asProviderId, type EnforcementMode, type LedgerEvent } from "@cosign/core";
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

/** Derive the moat metrics from the durable ledger (connects + freezes are recorded there). */
export async function metricsOf(core: CosignCore): Promise<MoatMetrics> {
  const records = await core.ledgerRecords();
  const connects: { id: string; at: number }[] = [];
  const seen = new Set<string>();
  let freezeCount = 0;
  let lastFreezeWindowMs: number | undefined;
  for (const r of records) {
    const e = r.payload as LedgerEvent;
    if (e.kind === "backend_connected" && !seen.has(String(e.providerId))) {
      seen.add(String(e.providerId));
      connects.push({ id: String(e.providerId), at: e.ts });
    } else if (e.kind === "freeze_requested") {
      freezeCount += 1;
    } else if (e.kind === "freeze_resolved") {
      lastFreezeWindowMs = e.windowMs;
    }
  }
  const second = connects[1];
  return {
    connectedCount: connects.length,
    multiBackend: connects.length >= 2,
    secondBackendConnectedAt: second?.at,
    timeToSecondBackendMs: connects[0] && second ? second.at - connects[0].at : undefined,
    connectOrder: connects,
    freezeCount,
    lastFreezeWindowMs,
  };
}

export interface BackendsView {
  backends: (BackendSpec & { connected: boolean })[];
  metrics: MoatMetrics;
}

export async function backendsView(core: CosignCore): Promise<BackendsView> {
  const connected = new Set(core.agents().map((a) => String(a.provider)));
  return {
    backends: BACKEND_CATALOG.map((b) => ({ ...b, connected: connected.has(b.id) })),
    metrics: await metricsOf(core),
  };
}

/**
 * Tap-to-connect a backend: lazily register its (mock) adapter, provision an agent, apply the shared
 * unified policy so the freeze has something to govern, and record a durable `backend_connected` row.
 * Idempotent per backend. `nowMs` is injectable for deterministic tests.
 */
export async function connectBackend(core: CosignCore, providerId: string, nowMs: () => number = Date.now): Promise<BackendsView> {
  const spec = BACKEND_CATALOG.find((b) => b.id === providerId);
  if (!spec) throw new Error(`unknown backend: ${providerId}`);

  const alreadyConnected = core.agents().some((a) => String(a.provider) === spec.id);
  if (!alreadyConnected) {
    if (!core.hasProvider(spec.id)) await core.registerProvider(new MockProvider({ id: spec.id, mode: spec.mode }));
    await core.provisionAgent(spec.id, asAgentId(`${spec.id}-agent`), spec.venue);
    // One unified policy, compiled to each backend's native controls (re-applied across all agents).
    await core.applyPolicy(definePolicy({ asset: "USDC", perTxCap: "100000000", allowlist: ["0xTREASURY"] }));
    // Durable, auditable record of the connect — the moat metric is derived from these rows.
    await core.recordEvent({ kind: "backend_connected", providerId: asProviderId(spec.id), ts: nowMs() });
  }
  return backendsView(core);
}
