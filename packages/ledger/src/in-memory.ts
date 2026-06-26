import type { LedgerEvent } from "@countersign/core";
import { GENESIS_HASH, makeRecord, verifyChain, type LedgerRecord, type LedgerSigner, type VerifyResult } from "./hash-chain";
import type { LedgerPort } from "./port";

/**
 * In-process ledger — backs the tests and the entire headline demo. Sub-millisecond, deterministic,
 * no infrastructure. The hash chain is identical to the Postgres adapter (both call hash-chain.ts).
 */
export class InMemoryLedger<T = LedgerEvent> implements LedgerPort<T> {
  private readonly rows: LedgerRecord<T>[] = [];
  readonly publicKey: string | undefined;

  constructor(private readonly signer?: LedgerSigner) {
    this.publicKey = signer?.publicKey;
  }

  async append(payload: T): Promise<LedgerRecord<T>> {
    const prev = this.rows.length > 0 ? this.rows[this.rows.length - 1]!.rowHash : GENESIS_HASH;
    const rec = makeRecord<T>(this.rows.length, prev, payload, this.signer);
    this.rows.push(rec);
    return rec;
  }

  async getByIndex(index: number): Promise<LedgerRecord<T> | undefined> {
    return this.rows[index];
  }

  async getHead(): Promise<LedgerRecord<T> | undefined> {
    return this.rows[this.rows.length - 1];
  }

  async all(): Promise<LedgerRecord<T>[]> {
    return this.rows.map((r) => ({ ...r }));
  }

  async size(): Promise<number> {
    return this.rows.length;
  }

  async verify(): Promise<VerifyResult> {
    return verifyChain(this.rows, this.signer);
  }

  async query(predicate: (payload: T) => boolean): Promise<LedgerRecord<T>[]> {
    return this.rows.filter((r) => predicate(r.payload)).map((r) => ({ ...r }));
  }

  /** TEST ONLY — corrupt a stored payload to prove the chain detects tampering. */
  async __danger_corruptPayload(index: number, payload: T): Promise<void> {
    this.rows[index]!.payload = payload;
  }

  /** TEST ONLY — drop a row to prove the chain detects a gap/reorder. */
  async __danger_deleteAt(index: number): Promise<void> {
    this.rows.splice(index, 1);
  }
}
