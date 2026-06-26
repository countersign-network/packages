import type { LedgerEvent } from "@countersign/core";
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
  /** The signer's public key (base64 SPKI), if the ledger is signed — publish it for verification. */
  readonly publicKey?: string | undefined;
  append(payload: T): Promise<LedgerRecord<T>>;
  getByIndex(index: number): Promise<LedgerRecord<T> | undefined>;
  getHead(): Promise<LedgerRecord<T> | undefined>;
  all(): Promise<LedgerRecord<T>[]>;
  size(): Promise<number>;
  verify(): Promise<VerifyResult>;
  query(predicate: (payload: T) => boolean): Promise<LedgerRecord<T>[]>;
}

/**
 * DB-level append-only guard for the Postgres-backed ledgers (pglite + real Postgres). A trigger
 * RAISES on any UPDATE/DELETE, so even a direct-SQL attacker is blocked at the storage layer — not
 * just by the absence of mutators on the port. Idempotent (safe to run on every connect). The
 * signed hash chain remains the backstop if the trigger is ever bypassed (e.g. a superuser disabling
 * it). Applies to the `ledger` table.
 */
export const APPEND_ONLY_TRIGGER_SQL = `
  CREATE OR REPLACE FUNCTION ledger_append_only() RETURNS trigger AS $$
  BEGIN RAISE EXCEPTION 'ledger is append-only: % is not permitted', TG_OP; END;
  $$ LANGUAGE plpgsql;
  DROP TRIGGER IF EXISTS ledger_no_mutate ON ledger;
  CREATE TRIGGER ledger_no_mutate BEFORE UPDATE OR DELETE ON ledger
    FOR EACH ROW EXECUTE FUNCTION ledger_append_only();
`;
