import { describe, it, expect } from "vitest";
import { CosignCore, createDemoCore, createLocalApi } from "@cosign/api";
import { InMemoryLedger, createEd25519Signer } from "@cosign/ledger";
import type { LedgerEvent } from "@cosign/core";

describe("embedded front door (createLocalApi over createDemoCore)", () => {
  it("runs the whole control plane in-process with no server, no creds", async () => {
    const { core, fleet } = await createDemoCore();
    expect(fleet).toHaveLength(3);
    const api = createLocalApi(core);

    const health = await api.health();
    expect(health.ok).toBe(true);
    expect(health.providers).toHaveLength(3);
    expect((await api.agents()).agents).toHaveLength(3);

    // default demo policy: perTxCap 100 USDC, allowlist [0xTREASURY]
    const base = { agentId: "payments-bot", asset: "USDC", venue: "base-sepolia" };
    expect((await api.evaluate({ ...base, amount: "50000000", counterparty: "0xTREASURY" })).outcome).toBe("allow");
    expect((await api.evaluate({ ...base, amount: "150000000", counterparty: "0xTREASURY" })).outcome).toBe("deny");
    expect((await api.evaluate({ ...base, amount: "1", counterparty: "0xSTRANGER" })).outcome).toBe("deny");

    const report = await api.freeze({ reason: "embedded test" });
    expect(report.allStopped).toBe(true);

    const ledger = await api.ledger();
    expect(ledger.verified).toBe(true);
    expect(ledger.records.length).toBeGreaterThan(0);
  });

  it("exposes the ledger public key for independent verification when signed", async () => {
    const signer = createEd25519Signer();
    const core = new CosignCore({ ledger: new InMemoryLedger<LedgerEvent>(signer) });
    const res = await createLocalApi(core).ledger();
    expect(res.publicKey).toBe(signer.publicKey);
  });
});
