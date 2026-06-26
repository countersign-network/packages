import type { LedgerPort } from "./port";

/**
 * External anchoring — periodically publish the ledger HEAD (its rowHash) somewhere the ledger's own
 * database operator can't rewrite. The signed hash chain already detects a recomputed chain; anchoring
 * adds the missing piece: a record, in a DIFFERENT trust domain, of what the head WAS at a point in
 * time — so even Countersign can't silently rewind history without the anchor disagreeing.
 *
 * The value comes entirely from the anchor's trust domain. Real implementations write the head hash
 * ON-CHAIN (e.g. via an already-integrated backend) or to a TRANSPARENCY LOG (Rekor-style). The
 * FileAnchor below is a local reference / audit trail ONLY — by itself it is NOT a cross-trust-domain
 * anchor (an attacker who owns the DB likely owns the file too). Ship the file off-host / to WORM
 * storage, or swap in an on-chain / transparency-log anchor, for the real guarantee.
 */
export interface AnchorPoint {
  index: number;
  rowHash: string;
  ts: number;
}

export interface LedgerAnchor {
  /** Publish the head; resolve an external REFERENCE (tx hash, log id, …) if the target has one. */
  anchor(point: AnchorPoint): Promise<string | undefined>;
}

/** The anchored point plus the external reference the anchor produced (if any). */
export type AnchoredPoint = AnchorPoint & { ref?: string };

/** Read the ledger head and publish it via the anchor. Returns the anchored point (undefined if empty). */
export async function anchorHead(
  ledger: LedgerPort,
  anchor: LedgerAnchor,
  now: () => number = () => Date.now(),
): Promise<AnchoredPoint | undefined> {
  const head = await ledger.getHead();
  if (!head) return undefined;
  const point: AnchorPoint = { index: head.index, rowHash: head.rowHash, ts: now() };
  const ref = await anchor.anchor(point);
  return ref ? { ...point, ref } : point;
}

/* ------------------------------------------------------------------ */
/* On-chain anchor — commit the head hash to a public blockchain        */
/* ------------------------------------------------------------------ */

const ANCHOR_TAG = "434e5452"; // "CNTR" — magic prefix so an anchor tx is self-identifying on-chain.

/**
 * Encode an anchor point as EVM calldata: `0x` + tag(4B) + index(uint64, 8B) + rowHash(32B). Anyone
 * reading the transaction can decode it and check it against Countersign's published `/ledger` head —
 * no Countersign cooperation required.
 */
export function encodeAnchorCalldata(point: AnchorPoint): `0x${string}` {
  const idx = BigInt(point.index).toString(16).padStart(16, "0");
  const hash = point.rowHash.replace(/^0x/, "").toLowerCase().padStart(64, "0");
  return `0x${ANCHOR_TAG}${idx}${hash}`;
}

/** Decode anchor calldata back to {index, rowHash}; undefined if it isn't a Countersign anchor tx. */
export function decodeAnchorCalldata(dataHex: string): { index: number; rowHash: string } | undefined {
  const h = dataHex.replace(/^0x/, "").toLowerCase();
  if (!h.startsWith(ANCHOR_TAG) || h.length < 8 + 16 + 64) return undefined;
  return { index: Number.parseInt(h.slice(8, 24), 16), rowHash: h.slice(24, 88) };
}

/** Sends a self-transaction carrying `dataHex` calldata and resolves the tx hash. Vendor-agnostic. */
export interface OnChainSender {
  send(dataHex: `0x${string}`): Promise<string>;
  /** Optional explorer base (e.g. https://sepolia.basescan.org/tx/) for logging. */
  readonly explorerTxBase?: string;
}

/**
 * Real cross-trust-domain anchor: writes the head hash into a public-chain transaction. The chain is
 * a trust domain Countersign does not control, so a silent history rewind is detectable by anyone who
 * compares the on-chain anchors to the live ledger. The `sender` is injected (any funded backend /
 * RPC), so this stays vendor-agnostic and unit-testable.
 */
export class OnChainAnchor implements LedgerAnchor {
  private readonly records: { point: AnchorPoint; txHash: string }[] = [];
  constructor(private readonly sender: OnChainSender) {}

  async anchor(point: AnchorPoint): Promise<string> {
    const txHash = await this.sender.send(encodeAnchorCalldata(point));
    this.records.push({ point, txHash });
    return txHash;
  }

  anchored(): readonly { point: AnchorPoint; txHash: string }[] {
    return this.records;
  }

  last(): { point: AnchorPoint; txHash: string } | undefined {
    return this.records[this.records.length - 1];
  }
}

/** Reference anchor: append-only JSONL of head snapshots. See the trust-domain caveat above. */
export class FileAnchor implements LedgerAnchor {
  constructor(private readonly path: string) {}

  async anchor(point: AnchorPoint): Promise<undefined> {
    const { appendFile } = await import("node:fs/promises");
    await appendFile(this.path, `${JSON.stringify(point)}\n`, "utf8");
    return undefined; // a local file is not an external reference
  }

  async read(): Promise<AnchorPoint[]> {
    const { readFile } = await import("node:fs/promises");
    try {
      const raw = await readFile(this.path, "utf8");
      return raw.split("\n").filter(Boolean).map((line) => JSON.parse(line) as AnchorPoint);
    } catch {
      return [];
    }
  }
}
