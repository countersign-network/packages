/**
 * @countersign/verify — independent, offline verification of a Countersign ledger entry.
 *
 * "Don't trust the dashboard — check the chain." This package is the check: given the response of
 * `GET /ledger/proof/:index` (a row, an RFC 6962 inclusion proof, and a checkpoint committing the
 * Merkle root), it re-derives everything from first principles with ZERO Countersign-hosted
 * dependencies:
 *
 *   1. payloadHash = sha256(canonicalJson(payload))        — the row really says what it claims
 *   2. rowHash     = sha256(prevHash + payloadHash)        — the row is chained to its predecessor
 *   3. row signature: Ed25519(rowHash) verifies against the published public key
 *   4. inclusion: fold the RFC 6962 audit path from the row hash to the checkpoint's Merkle root
 *   5. checkpoint signature: Ed25519 over `cs-checkpoint:v2:<size>:<headHash>:<merkleRoot>`
 *
 * The hashing rules here are the OPEN specification of the ledger's verification math (they mirror
 * the Core's implementation; the whitepaper documents the construction). Tampering with a payload
 * breaks 1→2; forging a row breaks 3; substituting a row breaks 4; serving a shortened or rewritten
 * ledger breaks 5 against any anchored/witnessed checkpoint.
 */

import { createHash, createPublicKey, verify as cryptoVerify } from "node:crypto";

/* ------------------------------------------------------------------ */
/* Canonical JSON + the hash chain                                     */
/* ------------------------------------------------------------------ */

/** Deterministic JSON: keys sorted, undefined dropped — structural equality ⇒ identical hash. */
export function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  const t = typeof value;
  if (t === "number" || t === "boolean" || t === "string") return JSON.stringify(value);
  if (t === "bigint") return JSON.stringify((value as bigint).toString());
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (t === "object") {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj)
      .filter((k) => obj[k] !== undefined)
      .sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(",")}}`;
  }
  return "null";
}

const sha256hex = (s: string): string => createHash("sha256").update(s).digest("hex");

export const payloadHash = (payload: unknown): string => sha256hex(canonicalJson(payload));
export const computeRowHash = (prevHash: string, pHash: string): string => sha256hex(prevHash + pHash);

/* ------------------------------------------------------------------ */
/* RFC 6962 Merkle verification                                        */
/* ------------------------------------------------------------------ */

const sha256buf = (...parts: (Buffer | string)[]): Buffer => {
  const h = createHash("sha256");
  for (const p of parts) h.update(p);
  return h.digest();
};

/** RFC 6962 §2.1 leaf hash: sha256(0x00 || utf8(leaf)). Leaves are rowHash hex strings. */
export const merkleLeafHash = (leaf: string): Buffer => sha256buf(Buffer.from([0x00]), Buffer.from(leaf, "utf8"));
const nodeHash = (l: Buffer, r: Buffer): Buffer => sha256buf(Buffer.from([0x01]), l, r);

export interface MerkleProof {
  index: number;
  size: number;
  /** Audit path, deepest-first; `side` = which side the SIBLING sits on when re-hashing upward. */
  siblings: { hash: string; side: "left" | "right" }[];
}

/** Fold an RFC 6962 audit path from a leaf (rowHash) to a root. Pure math, fully offline. */
export function verifyInclusion(leafRowHash: string, proof: MerkleProof, rootHex: string): boolean {
  let h = merkleLeafHash(leafRowHash);
  for (const s of proof.siblings) {
    const sib = Buffer.from(s.hash, "hex");
    h = s.side === "right" ? nodeHash(h, sib) : nodeHash(sib, h);
  }
  return h.toString("hex") === rootHex;
}

/* ------------------------------------------------------------------ */
/* Ed25519 signatures                                                  */
/* ------------------------------------------------------------------ */

/** Verify an Ed25519 signature (HEX, as the ledger emits) over a utf8 message with a base64-SPKI public key. */
export function verifySignature(message: string, signatureHex: string, publicKeyB64: string): boolean {
  try {
    const key = createPublicKey({ key: Buffer.from(publicKeyB64, "base64"), format: "der", type: "spki" });
    return cryptoVerify(null, Buffer.from(message, "utf8"), key, Buffer.from(signatureHex, "hex"));
  } catch {
    return false;
  }
}

/** The canonical checkpoint message (versioned): v1 without a Merkle root, v2 with it. */
export const checkpointMessage = (size: number, headHash: string, merkleRoot?: string): string =>
  merkleRoot === undefined ? `cs-checkpoint:v1:${size}:${headHash}` : `cs-checkpoint:v2:${size}:${headHash}:${merkleRoot}`;

/* ------------------------------------------------------------------ */
/* The full bundle check (the CLI's engine)                            */
/* ------------------------------------------------------------------ */

export interface ProofBundle {
  record: { index: number; prevHash: string; payloadHash: string; rowHash: string; payload: unknown; signature?: string };
  proof: MerkleProof;
  checkpoint: { size: number; headHash: string; merkleRoot?: string; ts: number; signature?: string };
  publicKey?: string;
}

export interface VerifyReport {
  ok: boolean;
  checks: {
    /** payload → payloadHash → rowHash all recompute to the served values. */
    chainHash: boolean;
    /** RFC 6962 audit path folds from the rowHash to the checkpoint's Merkle root. */
    inclusion: boolean;
    /** Ed25519 over the rowHash verifies (undefined = unsigned row or no public key supplied). */
    rowSignature?: boolean;
    /** Ed25519 over the checkpoint message verifies (undefined = unsigned checkpoint or no key). */
    checkpointSignature?: boolean;
  };
  problems: string[];
}

/** Verify a `GET /ledger/proof/:index` response bundle offline. `ok` = every applicable check passed. */
export function verifyProofBundle(bundle: ProofBundle, opts: { publicKey?: string } = {}): VerifyReport {
  const problems: string[] = [];
  const { record, proof, checkpoint } = bundle;
  const publicKey = opts.publicKey ?? bundle.publicKey;

  const pHash = payloadHash(record.payload);
  const rHash = computeRowHash(record.prevHash, pHash);
  const chainHash = pHash === record.payloadHash && rHash === record.rowHash;
  if (pHash !== record.payloadHash) problems.push("payload does not hash to the served payloadHash (payload tampered or reformatted)");
  else if (rHash !== record.rowHash) problems.push("prevHash+payloadHash does not hash to the served rowHash (chain link broken)");

  let inclusion = false;
  if (checkpoint.merkleRoot === undefined) {
    problems.push("checkpoint carries no Merkle root — cannot verify inclusion");
  } else if (proof.index !== record.index) {
    problems.push(`proof index ${proof.index} does not match the record index ${record.index}`);
  } else {
    inclusion = verifyInclusion(record.rowHash, proof, checkpoint.merkleRoot);
    if (!inclusion) problems.push("inclusion proof does not fold to the checkpoint's Merkle root");
  }

  let rowSignature: boolean | undefined;
  if (record.signature && publicKey) {
    rowSignature = verifySignature(record.rowHash, record.signature, publicKey);
    if (!rowSignature) problems.push("row signature does not verify against the public key");
  }

  let checkpointSignature: boolean | undefined;
  if (checkpoint.signature && publicKey) {
    checkpointSignature = verifySignature(
      checkpointMessage(checkpoint.size, checkpoint.headHash, checkpoint.merkleRoot),
      checkpoint.signature,
      publicKey,
    );
    if (!checkpointSignature) problems.push("checkpoint signature does not verify against the public key");
  }

  const ok = chainHash && inclusion && rowSignature !== false && checkpointSignature !== false;
  return {
    ok,
    checks: {
      chainHash,
      inclusion,
      ...(rowSignature !== undefined ? { rowSignature } : {}),
      ...(checkpointSignature !== undefined ? { checkpointSignature } : {}),
    },
    problems,
  };
}
