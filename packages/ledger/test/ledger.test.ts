import { describe, it, expect } from "vitest";
import { asProviderId, type LedgerEvent } from "@countersign/core";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rm } from "node:fs/promises";
import {
  FileAnchor,
  GENESIS_HASH,
  InMemoryLedger,
  OnChainAnchor,
  PgLedger,
  anchorHead,
  createEd25519Signer,
  decodeAnchorCalldata,
  encodeAnchorCalldata,
  makeRecord,
  verifyChain,
  type LedgerPort,
} from "@countersign/ledger";

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

    it("serializes concurrent appends — contiguous indices, no collision, chain verifies", async () => {
      const l = await adapter.make();
      const N = 25;
      // Fire all appends at once: without serialization they'd read the same head, compute the same
      // idx, and collide on the PK / fork the chain.
      const recs = await Promise.all(Array.from({ length: N }, (_, i) => l.append(freezeReq(i))));
      const indices = recs.map((r) => r.index).sort((a, b) => a - b);
      expect(indices).toEqual(Array.from({ length: N }, (_, i) => i)); // 0..N-1, each exactly once
      expect(await l.verify()).toEqual({ ok: true });
    });
  });
}

describe("DB-level append-only guard (PgLedger trigger)", () => {
  it("rejects a direct UPDATE even with full SQL access — the trigger RAISES, ledger stays intact", async () => {
    const l = await PgLedger.create<LedgerEvent>();
    await l.append(freezeReq(0));
    await l.append(freezeReq(1));

    // A raw UPDATE with the append-only trigger ACTIVE must be blocked at the storage layer.
    await expect(
      (l as unknown as { __danger_attemptBlockedUpdate(i: number): Promise<void> }).__danger_attemptBlockedUpdate(0),
    ).rejects.toThrow(/append-only/i);

    // History is untouched and still verifies (the guard prevented the tamper outright).
    expect(await l.size()).toBe(2);
    expect(await l.verify()).toEqual({ ok: true });
  });
});

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
    const path = join(tmpdir(), "countersign-anchor-test.jsonl");
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

  it("on-chain anchor calldata round-trips and rejects foreign calldata", () => {
    const point = { index: 7, rowHash: "a".repeat(64), ts: 1 };
    const data = encodeAnchorCalldata(point);
    expect(data.startsWith("0x434e5452")).toBe(true); // "CNTR" tag
    expect(decodeAnchorCalldata(data)).toEqual({ index: 7, rowHash: "a".repeat(64) });
    expect(decodeAnchorCalldata("0xdeadbeef")).toBeUndefined(); // not an anchor tx
  });

  it("OnChainAnchor commits the head to a chain; an independent verifier can decode the tx", async () => {
    const ledger = new InMemoryLedger<LedgerEvent>();
    await ledger.append(freezeReq(0));
    await ledger.append(freezeReq(1));
    const head = await ledger.getHead();

    // A mock chain sender captures the calldata and returns a tx hash.
    const sent: string[] = [];
    const anchor = new OnChainAnchor({
      async send(dataHex) {
        sent.push(dataHex);
        return "0xtxhash";
      },
    });

    const anchored = await anchorHead(ledger, anchor, () => 999);
    // anchorHead now surfaces the external reference (the tx hash) alongside the point.
    expect(anchored).toEqual({ index: 1, rowHash: head!.rowHash, ts: 999, ref: "0xtxhash" });
    expect(anchor.last()?.txHash).toBe("0xtxhash");

    // The on-chain bytes decode back to the live head — anyone can verify without Countersign.
    expect(decodeAnchorCalldata(sent[0]!)).toEqual({ index: 1, rowHash: head!.rowHash });
  });
});
