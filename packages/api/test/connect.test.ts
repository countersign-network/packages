import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { CosignCore, createCosignServer, type CosignServer } from "@cosign/api";

/** The moat-validation demo: connecting a SECOND backend is the headline, and it's instrumented. */
describe("connect-a-backend flow (moat demo)", () => {
  let server: CosignServer;
  let base: string;

  beforeAll(async () => {
    server = createCosignServer(new CosignCore());
    base = `http://localhost:${await server.listen(0)}`;
  });
  afterAll(async () => {
    await server.close();
  });

  const get = async (p: string) => (await fetch(`${base}${p}`)).json();
  const connect = async (providerId: string) =>
    (await fetch(`${base}/connect`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ providerId }) })).json();

  it("starts empty: catalog of 3 backends, none connected", async () => {
    const v = await get("/backends");
    expect(v.backends).toHaveLength(3);
    expect(v.backends.every((b: { connected: boolean }) => !b.connected)).toBe(true);
    expect(v.metrics.connectedCount).toBe(0);
    expect(v.metrics.multiBackend).toBe(false);
  });

  it("connecting ONE backend is not yet the moat", async () => {
    const v = await connect("coinbase");
    expect(v.backends.find((b: { id: string }) => b.id === "coinbase").connected).toBe(true);
    expect(v.metrics.connectedCount).toBe(1);
    expect(v.metrics.multiBackend).toBe(false);
    expect(v.metrics.secondBackendConnectedAt).toBeUndefined();
  });

  it("connecting a SECOND backend flips multiBackend + records the second-connect metric", async () => {
    const v = await connect("turnkey");
    expect(v.metrics.connectedCount).toBe(2);
    expect(v.metrics.multiBackend).toBe(true);
    expect(typeof v.metrics.secondBackendConnectedAt).toBe("number");
    expect(typeof v.metrics.timeToSecondBackendMs).toBe("number");
  });

  it("connect is idempotent per backend", async () => {
    const v = await connect("coinbase");
    expect(v.metrics.connectedCount).toBe(2); // unchanged
  });

  it("ONE freeze stops every connected backend, and the freeze is recorded in metrics", async () => {
    const report = await (await fetch(`${base}/freeze`, { method: "POST" })).json();
    expect(report.allStopped).toBe(true);
    expect(report.providers).toHaveLength(2);
    expect(report.windowMs).toBeLessThan(1000);

    const m = await get("/metrics");
    expect(m.freezeCount).toBe(1);
    expect(typeof m.lastFreezeWindowMs).toBe("number");
  });

  it("rejects an unknown backend", async () => {
    const res = await fetch(`${base}/connect`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ providerId: "ledgerx" }) });
    expect(res.status).toBe(400);
  });
});
