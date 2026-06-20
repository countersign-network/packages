/**
 * DB-agnostic hash-chain. The integrity logic lives HERE, in TypeScript — the database is dumb
 * append storage. That's the key decision: chain correctness is identical whether rows sit in an
 * in-memory array or Postgres, so we test tamper detection with zero infrastructure.
 *
 *   payloadHash = sha256(canonical(payload))
 *   rowHash     = sha256(prevHash + payloadHash)
 *
 * Each row commits to the entire history before it, so altering, deleting, or reordering any row
 * breaks every row after it — and verify() localizes the first break.
 */

import { createHash } from "node:crypto";
import type { LedgerEvent } from "@cosign/core";

export const GENESIS_HASH = "0".repeat(64);

export interface LedgerRecord<T = LedgerEvent> {
  index: number; // 0-based position in the chain
  prevHash: string; // rowHash of the previous record (GENESIS_HASH for index 0)
  payloadHash: string; // sha256(canonical(payload))
  rowHash: string; // sha256(prevHash + payloadHash)
  payload: T;
}

export function sha256hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

/**
 * Deterministic JSON: keys sorted, undefined dropped. Two structurally-equal payloads always
 * hash identically regardless of key insertion order — essential for stable tamper detection.
 */
export function canonicalize(value: unknown): string {
  if (value === null) return "null";
  const t = typeof value;
  if (t === "number" || t === "boolean" || t === "string") return JSON.stringify(value);
  if (t === "bigint") return JSON.stringify((value as bigint).toString());
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  if (t === "object") {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj)
      .filter((k) => obj[k] !== undefined)
      .sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalize(obj[k])}`).join(",")}}`;
  }
  return "null";
}

export const payloadHash = (payload: unknown): string => sha256hex(canonicalize(payload));
export const computeRowHash = (prevHash: string, pHash: string): string => sha256hex(prevHash + pHash);

export function makeRecord<T>(index: number, prevHash: string, payload: T): LedgerRecord<T> {
  const pHash = payloadHash(payload);
  return { index, prevHash, payloadHash: pHash, rowHash: computeRowHash(prevHash, pHash), payload };
}

export interface VerifyResult {
  ok: boolean;
  /** First index where the chain breaks (tamper, gap, or reorder). */
  brokenAt?: number;
}

export function verifyChain<T>(rows: readonly LedgerRecord<T>[]): VerifyResult {
  let prev = GENESIS_HASH;
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i]!;
    if (r.index !== i) return { ok: false, brokenAt: i };
    if (r.prevHash !== prev) return { ok: false, brokenAt: i };
    const pHash = payloadHash(r.payload);
    if (r.payloadHash !== pHash) return { ok: false, brokenAt: i };
    if (r.rowHash !== computeRowHash(r.prevHash, pHash)) return { ok: false, brokenAt: i };
    prev = r.rowHash;
  }
  return { ok: true };
}
