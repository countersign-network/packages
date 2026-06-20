import type { LedgerEvent } from "@cosign/core";
import type { LedgerRecord, VerifyResult } from "./hash-chain";

/**
 * The storage port. Deliberately has NO update or delete — the ledger is append-only by
 * construction (prime directive #5). Tamper resistance comes from the hash chain; immutability
 * comes from this interface having no way to mutate history.
 *
 * Structurally compatible with core's LedgerSink (append(event) => Promise<...>), so a ledger can
 * be handed straight to the FreezeController as its `record` sink.
 */
export interface LedgerPort<T = LedgerEvent> {
  append(payload: T): Promise<LedgerRecord<T>>;
  getByIndex(index: number): Promise<LedgerRecord<T> | undefined>;
  getHead(): Promise<LedgerRecord<T> | undefined>;
  all(): Promise<LedgerRecord<T>[]>;
  size(): Promise<number>;
  verify(): Promise<VerifyResult>;
  query(predicate: (payload: T) => boolean): Promise<LedgerRecord<T>[]>;
}
