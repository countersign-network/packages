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

import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign as cryptoSign,
  verify as cryptoVerify,
  type KeyObject,
} from "node:crypto";
import type { LedgerEvent } from "@countersign/core";

export const GENESIS_HASH = "0".repeat(64);

export interface LedgerRecord<T = LedgerEvent> {
  index: number; // 0-based position in the chain
  prevHash: string; // rowHash of the previous record (GENESIS_HASH for index 0)
  payloadHash: string; // sha256(canonical(payload))
  rowHash: string; // sha256(prevHash + payloadHash)
  payload: T;
  signature?: string; // Ed25519 signature over rowHash, when a signer is configured
}

/**
 * Signs each row's hash with a key the DATABASE never holds. The hash chain alone is tamper-evident
 * only if you trust the head; an attacker who owns the DB could recompute a valid chain. Signatures
 * close that: forging a row also requires the private key. Third parties verify with the public key —
 * which makes the ledger an audit artifact anyone can check, but only Countersign can write.
 */
export interface LedgerSigner {
  readonly publicKey: string; // base64 SPKI DER — safe to publish
  sign(message: string): string;
  verify(message: string, signature: string): boolean;
}

/** Ed25519 signer. Pass a base64 PKCS8 private key to reuse a stable identity; omit to generate one. */
export function createEd25519Signer(privateKeyB64?: string): LedgerSigner & { privateKeyB64: string } {
  const privateKey: KeyObject = privateKeyB64
    ? createPrivateKey({ key: Buffer.from(privateKeyB64, "base64"), format: "der", type: "pkcs8" })
    : generateKeyPairSync("ed25519").privateKey;
  const publicKeyObj = createPublicKey(privateKey);
  return {
    publicKey: publicKeyObj.export({ format: "der", type: "spki" }).toString("base64"),
    privateKeyB64: privateKey.export({ format: "der", type: "pkcs8" }).toString("base64"),
    sign: (message) => cryptoSign(null, Buffer.from(message, "utf8"), privateKey).toString("hex"),
    verify: (message, signature) => {
      try {
        return cryptoVerify(null, Buffer.from(message, "utf8"), publicKeyObj, Buffer.from(signature, "hex"));
      } catch {
        return false;
      }
    },
  };
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

export function makeRecord<T>(index: number, prevHash: string, payload: T, signer?: LedgerSigner): LedgerRecord<T> {
  const pHash = payloadHash(payload);
  const rowHash = computeRowHash(prevHash, pHash);
  const record: LedgerRecord<T> = { index, prevHash, payloadHash: pHash, rowHash, payload };
  if (signer) record.signature = signer.sign(rowHash);
  return record;
}

export interface VerifyResult {
  ok: boolean;
  /** First index where the chain breaks (tamper, gap, or reorder). */
  brokenAt?: number;
}

export function verifyChain<T>(rows: readonly LedgerRecord<T>[], signer?: LedgerSigner): VerifyResult {
  let prev = GENESIS_HASH;
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i]!;
    if (r.index !== i) return { ok: false, brokenAt: i };
    if (r.prevHash !== prev) return { ok: false, brokenAt: i };
    const pHash = payloadHash(r.payload);
    if (r.payloadHash !== pHash) return { ok: false, brokenAt: i };
    if (r.rowHash !== computeRowHash(r.prevHash, pHash)) return { ok: false, brokenAt: i };
    // With a signer, the row must also carry a valid signature — so a recomputed (but unsigned)
    // chain produced by a DB-level attacker is still detected.
    if (signer && (!r.signature || !signer.verify(r.rowHash, r.signature))) return { ok: false, brokenAt: i };
    prev = r.rowHash;
  }
  return { ok: true };
}
