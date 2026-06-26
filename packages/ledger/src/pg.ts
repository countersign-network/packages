import type { PGlite } from "@electric-sql/pglite";
import type { LedgerEvent } from "@countersign/core";
import { GENESIS_HASH, makeRecord, verifyChain, type LedgerRecord, type LedgerSigner, type VerifyResult } from "./hash-chain";
import type { LedgerPort } from "./port";

/**
 * Postgres-backed ledger. For tests + local dev it runs on pglite (embedded Postgres, in-process,
 * real SQL semantics, no daemon). In production this same schema/queries point at a real Postgres
 * connection. The chain integrity logic is shared with the in-memory adapter (hash-chain.ts), so
 * the DB is only ever dumb append storage.
 *
 * Append-only is enforced two ways: the LedgerPort exposes no update/delete, and the only write
 * path is INSERT. (A DB-level trigger blocking UPDATE/DELETE is the prod-hardening follow-up.)
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
    `);
    return new PgLedger<T>(db, signer);
  }

  async append(payload: T): Promise<LedgerRecord<T>> {
    const head = await this.getHead();
    const prev = head?.rowHash ?? GENESIS_HASH;
    const index = head ? head.index + 1 : 0;
    const rec = makeRecord<T>(index, prev, payload, this.signer);
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

  /** TEST ONLY — simulate an attacker with DB write access editing a row (bypassing append-only). */
  async __danger_corruptPayload(index: number, payload: T): Promise<void> {
    await this.db.query("UPDATE ledger SET payload = $1::jsonb WHERE idx = $2", [JSON.stringify(payload), index]);
  }

  /** TEST ONLY — delete a row to prove gap detection. */
  async __danger_deleteAt(index: number): Promise<void> {
    await this.db.query("DELETE FROM ledger WHERE idx = $1", [index]);
  }
}
