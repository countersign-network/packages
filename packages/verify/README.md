# @countersign/verify

**Don't trust the dashboard — check the chain.** Verify a Countersign ledger entry completely
offline: hash-chain recomputation, RFC 6962 Merkle inclusion, and Ed25519 signatures, with zero
Countersign-hosted dependencies and zero third-party packages (Node built-ins only).

```sh
# fetch a proof for ledger row 41, then verify it yourself:
curl -s -H "Authorization: Bearer $KEY" https://app.countersign.network/ledger/proof/41 > proof.json
npx @countersign/verify proof.json
```

```
row #41 of 57 (checkpoint ts 1784025776472)
  chain hashes recompute   ✓
  Merkle inclusion         ✓
  row signature            ✓
  checkpoint signature     ✓
VERIFIED — this entry is committed by the ledger.
```

What the checks mean:

1. **chain hashes** — `payloadHash = sha256(canonicalJson(payload))`, `rowHash = sha256(prevHash + payloadHash)`:
   the row really says what it claims, and is chained to its predecessor.
2. **Merkle inclusion** — the RFC 6962 audit path folds from the row hash to the checkpoint's Merkle
   root: the row is committed by the ledger as a whole.
3. **row signature** — Ed25519 over the rowHash verifies against the published public key: only the
   ledger's key could have written it.
4. **checkpoint signature** — Ed25519 over `cs-checkpoint:v2:<size>:<headHash>:<merkleRoot>`: the
   size + root commitment is authentic (and detects a served-you-a-shorter-ledger rollback when
   compared across checkpoints).

Pass `--root <hex>` to additionally require the Merkle root to equal a value you obtained
independently (e.g. from the on-chain anchor), and `--public-key <base64>` to pin the key.

Library use: `import { verifyProofBundle } from "@countersign/verify"`.

Apache-2.0. Part of the [Countersign](https://countersign.network) open core.
