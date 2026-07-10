import { describe, it, expect, vi, afterEach } from "vitest";
import {
  FreezeController,
  NotImplementedError,
  asAgentId,
  asProviderId,
  type AgentRef,
  type EnforcementMode,
  type EnforcementProvider,
  type FreezeResult,
  type FreezeScope,
  type LedgerEvent,
  type ProviderCapabilities,
  type ProviderRegistration,
} from "@countersign/core";

type FreezeBehavior = "confirm" | "unconfirmed" | "throw" | "hang";
type RevokeBehavior = "confirm" | "fail" | "hang";

interface FakeOpts {
  id: string;
  mode?: EnforcementMode;
  freeze: FreezeBehavior;
  revoke?: RevokeBehavior;
  freezeDelayMs?: number;
  revokeDelayMs?: number;
}

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const never = () => new Promise<never>(() => {});

function fakeRegistration(opts: FakeOpts): ProviderRegistration {
  const providerId = asProviderId(opts.id);
  const agents: AgentRef[] = [
    { provider: providerId, agentId: asAgentId(`${opts.id}-agent`), wallet: "0xWALLET", venue: "base-sepolia" },
  ];
  const mode: EnforcementMode = opts.mode ?? "native-session-caps";
  const capabilities: ProviderCapabilities = {
    enforcementMode: mode,
    supportsInlineApproval: mode === "pre-sign-policy",
    supportsOnchainGuard: mode === "onchain-policy",
    supportsSessionRevocation: true,
    realtimeEvents: true,
    venues: ["base-sepolia"],
  };

  const stub = (name: string) => () => {
    throw new NotImplementedError(`${opts.id}.${name}`);
  };

  const provider: EnforcementProvider = {
    id: providerId,
    capabilities: async () => capabilities,
    provisionWallet: stub("provisionWallet") as never,
    applyPolicy: stub("applyPolicy") as never,
    unfreeze: async () => {},
    subscribe: () => () => {},
    health: async () => ({ healthy: true }),
    async freeze(_scope: FreezeScope): Promise<FreezeResult> {
      if (opts.freeze === "hang") return never();
      if (opts.freezeDelayMs) await delay(opts.freezeDelayMs);
      if (opts.freeze === "throw") throw new Error(`${opts.id} freeze failed`);
      return {
        confirmed: opts.freeze === "confirm",
        frozenAgents: agents.map((a) => a.agentId),
        mechanism: "caps-zeroed",
        at: 0,
      };
    },
    async revokeSession(): Promise<void> {
      if (opts.revoke === "hang") return never();
      if (opts.revokeDelayMs) await delay(opts.revokeDelayMs);
      if (opts.revoke === "fail") throw new Error(`${opts.id} revoke failed`);
    },
  };

  return { provider, capabilities, agents };
}

function recorder() {
  const events: LedgerEvent[] = [];
  return { events, record: (e: LedgerEvent) => void events.push(e) };
}

const kinds = (events: LedgerEvent[]) => events.map((e) => e.kind);

afterEach(() => vi.useRealTimers());

describe("FreezeController — fail-closed cross-vendor freeze", () => {
  it("all providers confirm => allStopped, one freeze_result each, freeze_resolved", async () => {
    const { events, record } = recorder();
    const c = new FreezeController(
      [fakeRegistration({ id: "coinbase", freeze: "confirm" }), fakeRegistration({ id: "turnkey", mode: "pre-sign-policy", freeze: "confirm" }), fakeRegistration({ id: "openfort", mode: "onchain-policy", freeze: "confirm" })],
      { record },
    );
    const report = await c.freezeAll("test");

    expect(report.allStopped).toBe(true);
    expect(report.providers.map((p) => p.outcome)).toEqual(["confirmed", "confirmed", "confirmed"]);
    expect(kinds(events).filter((k) => k === "freeze_result")).toHaveLength(3);
    expect(kinds(events)).toContain("freeze_resolved");
    expect(kinds(events)).not.toContain("still_dangerous");
  });

  it("unconfirmed freeze but revokeSession succeeds => escalation saves it (allStopped)", async () => {
    const { events, record } = recorder();
    const c = new FreezeController(
      [fakeRegistration({ id: "coinbase", freeze: "confirm" }), fakeRegistration({ id: "openfort", mode: "onchain-policy", freeze: "unconfirmed", revoke: "confirm" })],
      { record },
    );
    const report = await c.freezeAll();

    expect(report.allStopped).toBe(true);
    const openfort = report.providers.find((p) => p.providerId === "openfort")!;
    expect(openfort.outcome).toBe("unconfirmed");
    expect(openfort.stopped).toBe(true); // escalation
    const esc = events.find((e) => e.kind === "escalation_revoke_session");
    expect(esc && esc.kind === "escalation_revoke_session" && esc.outcome).toBe("confirmed");
  });

  it("unconfirmed freeze AND revoke fails => still_dangerous with the agent named", async () => {
    const { events, record } = recorder();
    const c = new FreezeController(
      [fakeRegistration({ id: "coinbase", freeze: "confirm" }), fakeRegistration({ id: "turnkey", mode: "pre-sign-policy", freeze: "unconfirmed", revoke: "fail" })],
      { record },
    );
    const report = await c.freezeAll();

    expect(report.allStopped).toBe(false);
    const danger = events.find((e) => e.kind === "still_dangerous");
    expect(danger && danger.kind === "still_dangerous" && danger.dangerous).toEqual([
      { providerId: "turnkey", agentId: "turnkey-agent" },
    ]);
    expect(kinds(events)).toContain("freeze_partial");
  });

  it("freeze that THROWS is treated as failed (fail-closed), then escalated", async () => {
    const { events, record } = recorder();
    const c = new FreezeController([fakeRegistration({ id: "coinbase", freeze: "throw", revoke: "confirm" })], { record });
    const report = await c.freezeAll();
    expect(report.providers[0]!.outcome).toBe("failed");
    expect(report.providers[0]!.stopped).toBe(true); // revoke rescued it
    const fr = events.find((e) => e.kind === "freeze_result");
    expect(fr && fr.kind === "freeze_result" && fr.outcome).toBe("failed");
  });

  it("freeze that HANGS times out => failed within the bound (never blocks forever)", async () => {
    const { record } = recorder();
    const c = new FreezeController([fakeRegistration({ id: "coinbase", freeze: "hang", revoke: "confirm" })], {
      record,
      freezeTimeoutMs: 120,
      escalateTimeoutMs: 120,
    });
    const t0 = Date.now();
    const report = await c.freezeAll();
    const elapsed = Date.now() - t0;
    expect(report.providers[0]!.outcome).toBe("failed");
    expect(elapsed).toBeLessThan(600);
  });

  it("SLO: returns a complete verdict in < 1s even when a provider hangs both freeze and revoke", async () => {
    const windows: number[] = [];
    for (let i = 0; i < 10; i++) {
      const { record } = recorder();
      const c = new FreezeController(
        [
          fakeRegistration({ id: "coinbase", freeze: "confirm", freezeDelayMs: 40 }),
          fakeRegistration({ id: "turnkey", mode: "pre-sign-policy", freeze: "confirm", freezeDelayMs: 60 }),
          fakeRegistration({ id: "openfort", mode: "onchain-policy", freeze: "hang", revoke: "hang" }),
        ],
        { record, freezeTimeoutMs: 250, escalateTimeoutMs: 250 },
      );
      const t0 = Date.now();
      const report = await c.freezeAll();
      windows.push(Date.now() - t0);
      expect(report.allStopped).toBe(false); // the hanging provider is correctly still-dangerous
    }
    const p95 = windows.sort((a, b) => a - b)[Math.floor(windows.length * 0.95)]!;
    expect(p95).toBeLessThan(1000);
  });

  it("alert sink fires ONLY when still-dangerous, with the dangerous targets", async () => {
    const { record } = recorder();
    const alerts: { freezeId: string; dangerous: { providerId: string; agentId?: string }[] }[] = [];
    const alert = (a: { freezeId: string; dangerous: { providerId: string; agentId?: string }[] }) => void alerts.push(a);

    // All confirm → no alert.
    await new FreezeController([fakeRegistration({ id: "coinbase", freeze: "confirm" })], { record, alert }).freezeAll();
    expect(alerts).toHaveLength(0);

    // Unconfirmed + revoke fails → still dangerous → exactly one alert naming the target.
    await new FreezeController(
      [fakeRegistration({ id: "turnkey", mode: "pre-sign-policy", freeze: "unconfirmed", revoke: "fail" })],
      { record, alert },
    ).freezeAll("kill");
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.dangerous).toEqual([{ providerId: "turnkey", agentId: "turnkey-agent" }]);
  });

  it("a throwing alert sink never breaks the freeze (best-effort)", async () => {
    const { record } = recorder();
    const c = new FreezeController(
      [fakeRegistration({ id: "turnkey", mode: "pre-sign-policy", freeze: "unconfirmed", revoke: "fail" })],
      { record, alert: () => { throw new Error("pager down"); } },
    );
    const report = await c.freezeAll();
    expect(report.allStopped).toBe(false); // freeze still returns its verdict despite the alert throwing
  });

  it("parallel fan-out (fake timers): three freezes of 300/500/800ms settle within one 800ms window", async () => {
    vi.useFakeTimers();
    const { events, record } = recorder();
    const c = new FreezeController(
      [
        fakeRegistration({ id: "coinbase", freeze: "confirm", freezeDelayMs: 300 }),
        fakeRegistration({ id: "turnkey", mode: "pre-sign-policy", freeze: "confirm", freezeDelayMs: 500 }),
        fakeRegistration({ id: "openfort", mode: "onchain-policy", freeze: "confirm", freezeDelayMs: 800 }),
      ],
      { record, freezeTimeoutMs: 5000 },
    );
    const p = c.freezeAll();
    // If the fan-out were serial it would need 300+500+800=1600ms; advancing only 800ms proves parallel.
    await vi.advanceTimersByTimeAsync(800);
    const report = await p;
    expect(report.allStopped).toBe(true);
    expect(report.windowMs).toBeLessThanOrEqual(800);
    expect(kinds(events).filter((k) => k === "freeze_result")).toHaveLength(3);
  });
});

describe("FreezeController — agent-scoped freeze on an unknown agent is fail-closed", () => {
  it("returns allStopped:false (not a phantom success) and records no freeze_resolved", async () => {
    const { events, record } = recorder();
    const c = new FreezeController([fakeRegistration({ id: "coinbase", freeze: "confirm" })], { record });
    // "coinbase-agent" is the only registered agent; scope the kill to a DIFFERENT (stale/typo'd) id.
    const report = await c.freezeAgent(asAgentId("ghost-agent"), "typo");
    expect(report.allStopped).toBe(false); // matched nothing => not a stop (was true before the fix)
    expect(report.providers).toEqual([]);
    expect(kinds(events)).not.toContain("freeze_resolved"); // no misleading "resolved" for a no-op
  });

  it("a KNOWN agent still freezes and reports allStopped:true", async () => {
    const { record } = recorder();
    const c = new FreezeController([fakeRegistration({ id: "coinbase", freeze: "confirm" })], { record });
    const report = await c.freezeAgent(asAgentId("coinbase-agent"));
    expect(report.allStopped).toBe(true);
    expect(report.providers).toHaveLength(1);
  });
});
