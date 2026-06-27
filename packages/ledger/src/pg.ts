import type { PGlite } from "@electric-sql/pglite";
import type { LedgerEvent } from "@countersign/core";
import { GENESIS_HASH, makeRecord, verifyChain, type LedgerRecord, type LedgerSigner, type VerifyResult } from "./hash-chain";
import { APPEND_ONLY_TRIGGER_SQL, type LedgerPort } from "./port";

/**
 * Postgres-backed ledger. For tests + local dev it runs on pglite (embedded Postgres, in-process,
 * real SQL semantics, no daemon). In production this same schema/queries point at a real Postgres
 * connection. The chain integrity logic is shared with the in-memory adapter (hash-chain.ts), so
 * the DB is only ever dumb append storage.
 *
 * Append-only is enforced THREE ways (defense in depth): the LedgerPort exposes no update/delete; the
 * only write path is INSERT; and a DB-level trigger RAISES on any UPDATE/DELETE, so even a direct
 * SQL attacker with the connection is blocked. If they somehow bypass the trigger (e.g. superuser
 * disabling it), the Ed25519-signed hash chain still DETECTS the tamper on the next verify().
 */
interface Row {
  idx: number;
  prev_hash: string;
  payload_hash: string;
  row_hash: string;
  payload: unknown;
  signature: string | null;
}

export class PgLedger<T = LedgerEvent> implements LedgerPort<T> {
  private tail: Promise<unknown> = Promise.resolve();
  readonly publicKey: string | undefined;

  private constructor(
    private readonly db: PGlite,
    private readonly signer?: LedgerSigner,
  ) {
    this.publicKey = signer?.publicKey;
  }

  /** Create an embedded (pglite) ledger. Pass a connection string for a real Postgres later. */
  static async create<T = LedgerEvent>(dataDir?: string, signer?: LedgerSigner): Promise<PgLedger<T>> {
    const { PGlite } = await import("@electric-sql/pglite");
    const db = dataDir ? new PGlite(dataDir) : new PGlite();
    await db.exec(`
      CREATE TABLE IF NOT EXISTS ledger (
        idx          INTEGER PRIMARY KEY,
        prev_hash    TEXT NOT NULL,
        payload_hash TEXT NOT NULL,
        row_hash     TEXT NOT NULL,
        payload      JSONB NOT NULL,
        signature    TEXT
      );
      ${APPEND_ONLY_TRIGGER_SQL}
    `);
    return new PgLedger<T>(db, signer);
  }

  append(payload: T): Promise<LedgerRecord<T>> {
    // Serialize appends: the hash chain is inherently sequential (each row's prevHash is the prior
    // row's rowHash), so two concurrent appends must not both read the same head — they'd compute the
    // same idx and collide on the PRIMARY KEY (or fork the chain). Chain off a tail promise.
    const next = this.tail.then(() => this.appendNow(payload));
    this.tail = next.catch(() => undefined); // keep the chain going even if one append rejects
    return next;
  }

  private async appendNow(payload: T): Promise<LedgerRecord<T>> {
    const head = await this.getHead();
    const prev = head?.rowHash ?? GENESIS_HASH;
    const index = head ? head.index + 1 : 0;
    const rec = await makeRecord<T>(index, prev, payload, this.signer);
    await this.db.query(
      "INSERT INTO ledger (idx, prev_hash, payload_hash, row_hash, payload, signature) VALUES ($1, $2, $3, $4, $5::jsonb, $6)",
      [rec.index, rec.prevHash, rec.payloadHash, rec.rowHash, JSON.stringify(rec.payload), rec.signature ?? null],
    );
    return rec;
  }

  private toRecord(r: Row): LedgerRecord<T> {
    return {
      index: r.idx,
      prevHash: r.prev_hash,
      payloadHash: r.payload_hash,
      rowHash: r.row_hash,
      payload: r.payload as T,
      ...(r.signature ? { signature: r.signature } : {}),
    };
  }

  async getByIndex(index: number): Promise<LedgerRecord<T> | undefined> {
    const res = await this.db.query<Row>("SELECT * FROM ledger WHERE idx = $1", [index]);
    const row = res.rows[0];
    return row ? this.toRecord(row) : undefined;
  }

  async getHead(): Promise<LedgerRecord<T> | undefined> {
    const res = await this.db.query<Row>("SELECT * FROM ledger ORDER BY idx DESC LIMIT 1");
    const row = res.rows[0];
    return row ? this.toRecord(row) : undefined;
  }

  async all(): Promise<LedgerRecord<T>[]> {
    const res = await this.db.query<Row>("SELECT * FROM ledger ORDER BY idx ASC");
    return res.rows.map((r) => this.toRecord(r));
  }

  async size(): Promise<number> {
    const res = await this.db.query<{ n: number }>("SELECT COUNT(*)::int AS n FROM ledger");
    return res.rows[0]?.n ?? 0;
  }

  async verify(): Promise<VerifyResult> {
    return verifyChain(await this.all(), this.signer);
  }

  async query(predicate: (payload: T) => boolean): Promise<LedgerRecord<T>[]> {
    return (await this.all()).filter((r) => predicate(r.payload));
  }

  /**
   * TEST ONLY — simulate a SOPHISTICATED attacker who has bypassed the DB-level append-only trigger
   * (e.g. a superuser who disabled it) and edits a row directly. Proves the signed hash chain still
   * DETECTS the tamper even past the trigger. Normal UPDATEs (trigger active) are rejected — see
   * __danger_attemptBlockedUpdate.
   */
  async __danger_corruptPayload(index: number, payload: T): Promise<void> {
    await this.db.exec("ALTER TABLE ledger DISABLE TRIGGER USER");
    await this.db.query("UPDATE ledger SET payload = $1::jsonb WHERE idx = $2", [JSON.stringify(payload), index]);
    await this.db.exec("ALTER TABLE ledger ENABLE TRIGGER USER");
  }

  /** TEST ONLY — delete a row (bypassing the trigger) to prove gap detection by the hash chain. */
  async __danger_deleteAt(index: number): Promise<void> {
    await this.db.exec("ALTER TABLE ledger DISABLE TRIGGER USER");
    await this.db.query("DELETE FROM ledger WHERE idx = $1", [index]);
    await this.db.exec("ALTER TABLE ledger ENABLE TRIGGER USER");
  }

  /** TEST ONLY — a direct UPDATE with the trigger ACTIVE; must be rejected by the append-only guard. */
  async __danger_attemptBlockedUpdate(index: number): Promise<void> {
    await this.db.query("UPDATE ledger SET payload = '{}'::jsonb WHERE idx = $1", [index]);
  }
}
