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
  // ASYNC so a production signer can sign in a KMS/HSM (a network round-trip) without the private key
  // ever entering this process. The local Ed25519 signer just resolves immediately.
  sign(message: string): Promise<string>;
  verify(message: string, signature: string): Promise<boolean>;
}

/**
 * Ed25519 signer with the private key IN-PROCESS. Pass a base64 PKCS8 private key to reuse a stable
 * identity; omit to generate one. Fine for dev/test, but in production the key sits in an env var and
 * is exfiltratable — prefer createExternalSigner backed by a KMS/HSM so the ledger stays tamper-
 * evident even against a host compromise (see PRODUCTION-READINESS.md).
 */
export function createEd25519Signer(privateKeyB64?: string): LedgerSigner & { privateKeyB64: string } {
  const privateKey: KeyObject = privateKeyB64
    ? createPrivateKey({ key: Buffer.from(privateKeyB64, "base64"), format: "der", type: "pkcs8" })
    : generateKeyPairSync("ed25519").privateKey;
  const publicKeyObj = createPublicKey(privateKey);
  return {
    publicKey: publicKeyObj.export({ format: "der", type: "spki" }).toString("base64"),
    privateKeyB64: privateKey.export({ format: "der", type: "pkcs8" }).toString("base64"),
    sign: async (message) => cryptoSign(null, Buffer.from(message, "utf8"), privateKey).toString("hex"),
    verify: async (message, signature) => {
      try {
        return cryptoVerify(null, Buffer.from(message, "utf8"), publicKeyObj, Buffer.from(signature, "hex"));
      } catch {
        return false;
      }
    },
  };
}

/**
 * Wrap an EXTERNAL signer (AWS KMS / GCP KMS / an HSM) as a LedgerSigner — the production posture. The
 * private key NEVER enters this process: you supply an async `sign` that calls the KMS, plus the SPKI
 * public key (base64). `verify` defaults to a LOCAL check against `publicKey`, so verification needs no
 * KMS round-trip. This is the seam that makes the ledger forgery-resistant even if the host is popped.
 */
export function createExternalSigner(opts: {
  publicKey: string;
  sign: (message: string) => Promise<string>;
  verify?: (message: string, signature: string) => Promise<boolean>;
}): LedgerSigner {
  const publicKeyObj = createPublicKey({ key: Buffer.from(opts.publicKey, "base64"), format: "der", type: "spki" });
  return {
    publicKey: opts.publicKey,
    sign: opts.sign,
    verify:
      opts.verify ??
      (async (message, signature) => {
        try {
          return cryptoVerify(null, Buffer.from(message, "utf8"), publicKeyObj, Buffer.from(signature, "hex"));
        } catch {
          return false;
        }
      }),
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

export async function makeRecord<T>(index: number, prevHash: string, payload: T, signer?: LedgerSigner): Promise<LedgerRecord<T>> {
  const pHash = payloadHash(payload);
  const rowHash = computeRowHash(prevHash, pHash);
  const record: LedgerRecord<T> = { index, prevHash, payloadHash: pHash, rowHash, payload };
  if (signer) record.signature = await signer.sign(rowHash);
  return record;
}

export interface VerifyResult {
  ok: boolean;
  /** First index where the chain breaks (tamper, gap, or reorder). */
  brokenAt?: number;
}

export async function verifyChain<T>(rows: readonly LedgerRecord<T>[], signer?: LedgerSigner): Promise<VerifyResult> {
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
    if (signer && (!r.signature || !(await signer.verify(r.rowHash, r.signature)))) return { ok: false, brokenAt: i };
    prev = r.rowHash;
  }
  return { ok: true };
}
