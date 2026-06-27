import type { Pool } from "pg";
import type { LedgerEvent } from "@countersign/core";
import { GENESIS_HASH, makeRecord, verifyChain, type LedgerRecord, type LedgerSigner, type VerifyResult } from "./hash-chain";
import { APPEND_ONLY_TRIGGER_SQL, type LedgerPort } from "./port";

/**
 * Production ledger over a real (networked) Postgres — e.g. Render's managed Postgres via
 * DATABASE_URL. Same hash-chain logic as the other adapters (hash-chain.ts); the DB is dumb append
 * storage. Use this in deploys; pglite (PgLedger) is for tests/local, in-memory for the demo.
 *
 * Appends are serialized in-app so the inherently-sequential hash chain stays correct even behind a
 * connection pool. This assumes a SINGLE writer instance (the right shape for a ledger writer); a
 * multi-instance deployment would need a DB advisory lock / SELECT ... FOR UPDATE on the head row.
 */
// Fixed key for the ledger's transaction-scoped advisory lock (0x434E5452 = "CNTR"). All Core
// instances on the same DB contend on this one lock, so appends serialize cluster-wide.
const LEDGER_ADVISORY_LOCK_KEY = 0x434e5452;

interface Row {
  idx: number;
  prev_hash: string;
  payload_hash: string;
  row_hash: string;
  payload: unknown;
  signature: string | null;
}

export class PostgresLedger<T = LedgerEvent> implements LedgerPort<T> {
  private tail: Promise<unknown> = Promise.resolve();
  readonly publicKey: string | undefined;

  private constructor(
    private readonly pool: Pool,
    private readonly signer?: LedgerSigner,
  ) {
    this.publicKey = signer?.publicKey;
  }

  static async create<T = LedgerEvent>(connectionString: string, signer?: LedgerSigner): Promise<PostgresLedger<T>> {
    const { Pool } = await import("pg");
    const ssl = /sslmode=require/.test(connectionString) ? { rejectUnauthorized: false } : false;
    const pool = new Pool({ connectionString, ssl });
    await pool.query(`
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
    return new PostgresLedger<T>(pool, signer);
  }

  append(payload: T): Promise<LedgerRecord<T>> {
    const next = this.tail.then(() => this.appendNow(payload));
    this.tail = next.catch(() => undefined); // keep the chain going even if one append rejects
    return next;
  }

  private async appendNow(payload: T): Promise<LedgerRecord<T>> {
    // HA-safe across instances: the in-app `tail` mutex only serializes ONE process. With multiple
    // Core instances on the same DB, two appends could read the same head, compute the same idx, and
    // collide on the PK / fork the chain. So acquire a transaction-scoped Postgres ADVISORY LOCK,
    // then read the head and insert inside that same transaction — the lock auto-releases on commit/
    // rollback, serializing the head-read→insert critical section cluster-wide.
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock($1)", [LEDGER_ADVISORY_LOCK_KEY]);
      const headRes = await client.query<Row>("SELECT * FROM ledger ORDER BY idx DESC LIMIT 1");
      const head = headRes.rows[0] ? this.toRecord(headRes.rows[0]) : undefined;
      const prev = head?.rowHash ?? GENESIS_HASH;
      const index = head ? head.index + 1 : 0;
      const rec = makeRecord<T>(index, prev, payload, this.signer);
      await client.query(
        "INSERT INTO ledger (idx, prev_hash, payload_hash, row_hash, payload, signature) VALUES ($1, $2, $3, $4, $5::jsonb, $6)",
        [rec.index, rec.prevHash, rec.payloadHash, rec.rowHash, JSON.stringify(rec.payload), rec.signature ?? null],
      );
      await client.query("COMMIT");
      return rec;
    } catch (err) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
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
    const res = await this.pool.query("SELECT * FROM ledger WHERE idx = $1", [index]);
    const row = res.rows[0] as Row | undefined;
    return row ? this.toRecord(row) : undefined;
  }

  async getHead(): Promise<LedgerRecord<T> | undefined> {
    const res = await this.pool.query("SELECT * FROM ledger ORDER BY idx DESC LIMIT 1");
    const row = res.rows[0] as Row | undefined;
    return row ? this.toRecord(row) : undefined;
  }

  async all(): Promise<LedgerRecord<T>[]> {
    const res = await this.pool.query("SELECT * FROM ledger ORDER BY idx ASC");
    return (res.rows as Row[]).map((r) => this.toRecord(r));
  }

  async size(): Promise<number> {
    const res = await this.pool.query("SELECT COUNT(*)::int AS n FROM ledger");
    return Number((res.rows[0] as { n: number } | undefined)?.n ?? 0);
  }

  async verify(): Promise<VerifyResult> {
    return verifyChain(await this.all(), this.signer);
  }

  async query(predicate: (payload: T) => boolean): Promise<LedgerRecord<T>[]> {
    return (await this.all()).filter((r) => predicate(r.payload));
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
