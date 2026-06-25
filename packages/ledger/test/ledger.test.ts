import { describe, it, expect } from "vitest";
import { asProviderId, type LedgerEvent } from "@cosign/core";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rm } from "node:fs/promises";
import {
  FileAnchor,
  GENESIS_HASH,
  InMemoryLedger,
  PgLedger,
  anchorHead,
  createEd25519Signer,
  makeRecord,
  verifyChain,
  type LedgerPort,
} from "@cosign/ledger";

type Tamperable = LedgerPort<LedgerEvent> & {
  __danger_corruptPayload(index: number, payload: LedgerEvent): Promise<void>;
  __danger_deleteAt(index: number): Promise<void>;
};

const COINBASE = asProviderId("coinbase");

const freezeReq = (i: number): LedgerEvent => ({
  kind: "freeze_requested",
  freezeId: `frz_${i}`,
  targets: [COINBASE],
  reason: `attempt ${i}`,
  ts: 1_000 + i,
});

const adapters: { name: string; make: () => Promise<Tamperable> }[] = [
  { name: "InMemoryLedger", make: async () => new InMemoryLedger<LedgerEvent>() },
  { name: "PgLedger (pglite)", make: async () => await PgLedger.create<LedgerEvent>() },
];

for (const adapter of adapters) {
  describe(`hash-chained ledger conformance — ${adapter.name}`, () => {
    it("appends link prev->row hashes and verify() passes", async () => {
      const l = await adapter.make();
      const a = await l.append(freezeReq(0));
      const b = await l.append(freezeReq(1));
      const c = await l.append(freezeReq(2));

      expect(a.index).toBe(0);
      expect(a.prevHash).toBe(GENESIS_HASH);
      expect(b.prevHash).toBe(a.rowHash);
      expect(c.prevHash).toBe(b.rowHash);
      expect(await l.size()).toBe(3);
      expect((await l.getHead())!.index).toBe(2);
      expect(await l.verify()).toEqual({ ok: true });
    });

    it("detects a tampered payload and localizes the break", async () => {
      const l = await adapter.make();
      await l.append(freezeReq(0));
      await l.append(freezeReq(1));
      await l.append(freezeReq(2));

      await l.__danger_corruptPayload(1, {
        kind: "freeze_requested",
        freezeId: "frz_1",
        targets: [COINBASE],
        reason: "TAMPERED",
        ts: 1_001,
      });

      expect(await l.verify()).toEqual({ ok: false, brokenAt: 1 });
    });

    it("detects a deleted/reordered row as a gap", async () => {
      const l = await adapter.make();
      await l.append(freezeReq(0));
      await l.append(freezeReq(1));
      await l.append(freezeReq(2));

      await l.__danger_deleteAt(1);

      const v = await l.verify();
      expect(v.ok).toBe(false);
      expect(v.brokenAt).toBe(1);
    });

    it("query filters by payload predicate", async () => {
      const l = await adapter.make();
      await l.append(freezeReq(0));
      await l.append({ kind: "freeze_resolved", freezeId: "frz_0", providerCount: 1, windowMs: 42, ts: 2_000 });
      await l.append(freezeReq(1));

      const resolved = await l.query((e) => e.kind === "freeze_resolved");
      expect(resolved).toHaveLength(1);
      expect(resolved[0]!.payload.kind).toBe("freeze_resolved");
    });

    it("is append-only: exposes no update/delete on the port", async () => {
      const l = await adapter.make();
      expect((l as unknown as Record<string, unknown>)["update"]).toBeUndefined();
      expect((l as unknown as Record<string, unknown>)["delete"]).toBeUndefined();
    });
  });
}

describe("ledger signing (tamper-evident even against the DB owner)", () => {
  it("a signed ledger appends + verifies, and every row carries a signature", async () => {
    const signer = createEd25519Signer();
    const l = new InMemoryLedger<LedgerEvent>(signer);
    const a = await l.append(freezeReq(0));
    await l.append(freezeReq(1));
    expect(a.signature).toBeTruthy();
    expect(await l.verify()).toEqual({ ok: true });
  });

  it("signatures defeat a RECOMPUTED-chain attack that fools hash-only verification", () => {
    const signer = createEd25519Signer();
    const r0 = makeRecord(0, GENESIS_HASH, freezeReq(0), signer);
    const r1 = makeRecord(1, r0.rowHash, freezeReq(1), signer);
    const r2 = makeRecord(2, r1.rowHash, freezeReq(2), signer);
    expect(verifyChain([r0, r1, r2], signer)).toEqual({ ok: true });

    // Attacker with full DB access tampers row 1 and RECOMPUTES the hashes forward — but has no key.
    const t1 = makeRecord(1, r0.rowHash, { ...freezeReq(1), reason: "TAMPERED" }); // valid hashes, NO signature
    const t2 = makeRecord(2, t1.rowHash, freezeReq(2)); // re-chained

    // Hash-only verification is fooled (the recomputed chain is internally consistent):
    expect(verifyChain([r0, t1, t2])).toEqual({ ok: true });
    // But signature verification catches it at the first forged row:
    expect(verifyChain([r0, t1, t2], signer)).toEqual({ ok: false, brokenAt: 1 });
  });

  it("a different key cannot verify another signer's ledger", () => {
    const a = createEd25519Signer();
    const b = createEd25519Signer();
    const r0 = makeRecord(0, GENESIS_HASH, freezeReq(0), a);
    expect(verifyChain([r0], a)).toEqual({ ok: true });
    expect(verifyChain([r0], b).ok).toBe(false);
  });
});

describe("external anchoring seam", () => {
  it("anchorHead publishes the ledger head to a separate store (FileAnchor)", async () => {
    const path = join(tmpdir(), "cosign-anchor-test.jsonl");
    await rm(path, { force: true });

    const ledger = new InMemoryLedger<LedgerEvent>();
    await ledger.append(freezeReq(0));
    await ledger.append(freezeReq(1));

    const anchor = new FileAnchor(path);
    const point = await anchorHead(ledger, anchor, () => 12345);
    const head = await ledger.getHead();

    expect(point).toEqual({ index: 1, rowHash: head!.rowHash, ts: 12345 });
    expect(await anchor.read()).toEqual([point]); // recorded in the external store
    await rm(path, { force: true });
  });
});
