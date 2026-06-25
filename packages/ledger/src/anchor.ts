import type { LedgerPort } from "./port";

/**
 * External anchoring — periodically publish the ledger HEAD (its rowHash) somewhere the ledger's own
 * database operator can't rewrite. The signed hash chain already detects a recomputed chain; anchoring
 * adds the missing piece: a record, in a DIFFERENT trust domain, of what the head WAS at a point in
 * time — so even Cosign can't silently rewind history without the anchor disagreeing.
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
  anchor(point: AnchorPoint): Promise<void>;
}

/** Read the ledger head and publish it via the anchor. Returns the anchored point (undefined if empty). */
export async function anchorHead(
  ledger: LedgerPort,
  anchor: LedgerAnchor,
  now: () => number = () => Date.now(),
): Promise<AnchorPoint | undefined> {
  const head = await ledger.getHead();
  if (!head) return undefined;
  const point: AnchorPoint = { index: head.index, rowHash: head.rowHash, ts: now() };
  await anchor.anchor(point);
  return point;
}

/** Reference anchor: append-only JSONL of head snapshots. See the trust-domain caveat above. */
export class FileAnchor implements LedgerAnchor {
  constructor(private readonly path: string) {}

  async anchor(point: AnchorPoint): Promise<void> {
    const { appendFile } = await import("node:fs/promises");
    await appendFile(this.path, `${JSON.stringify(point)}\n`, "utf8");
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
