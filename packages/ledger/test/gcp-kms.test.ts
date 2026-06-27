import { describe, it, expect } from "vitest";
import { generateKeyPairSync, sign as cryptoSign } from "node:crypto";
import type { LedgerEvent } from "@countersign/core";
import { InMemoryLedger, createGcpKmsSigner, type GcpKmsClient } from "@countersign/ledger";

/**
 * A fake Cloud KMS: the Ed25519 private key lives "inside KMS" (here, the closure). The process only
 * ever calls getPublicKey + asymmetricSign — exactly the surface createGcpKmsSigner uses — so this
 * proves the seam without any GCP creds. Signs in "pure" EdDSA mode (data in), like EC_SIGN_ED25519.
 */
function fakeKms(): { client: GcpKmsClient; signCalls: () => number } {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const pem = publicKey.export({ format: "pem", type: "spki" }).toString();
  let signCalls = 0;
  return {
    signCalls: () => signCalls,
    client: {
      async getPublicKey() {
        return [{ pem }];
      },
      async asymmetricSign({ data }) {
        signCalls++;
        return [{ signature: cryptoSign(null, Buffer.from(data), privateKey) }];
      },
    },
  };
}

const evt = (i: number): LedgerEvent => ({ kind: "freeze_requested", freezeId: `frz_${i}`, targets: [], reason: "t", ts: i });
const KV = "projects/p/locations/l/keyRings/r/cryptoKeys/k/cryptoKeyVersions/1";

describe("GCP KMS ledger signer (key stays in KMS; verify is local)", () => {
  it("signs each ledger row via KMS and the chain verifies with the published public key", async () => {
    const { client, signCalls } = fakeKms();
    const signer = await createGcpKmsSigner(KV, client);
    expect(signer.publicKey).toBeTruthy(); // SPKI base64, fetched from KMS getPublicKey

    const l = new InMemoryLedger<LedgerEvent>(signer);
    const a = await l.append(evt(0));
    await l.append(evt(1));
    expect(a.signature).toBeTruthy();
    expect(signCalls()).toBe(2); // one KMS asymmetricSign per appended row
    expect(await l.verify()).toEqual({ ok: true }); // verified LOCALLY — no KMS round-trip
  });

  it("detects a tampered row even though signing went through KMS", async () => {
    const { client } = fakeKms();
    const l = new InMemoryLedger<LedgerEvent>(await createGcpKmsSigner(KV, client));
    await l.append(evt(0));
    await l.append(evt(1));
    await (l as unknown as { __danger_corruptPayload(i: number, p: LedgerEvent): Promise<void> }).__danger_corruptPayload(1, evt(99));
    expect((await l.verify()).ok).toBe(false);
  });

  it("throws if KMS returns no public key (fail-closed setup)", async () => {
    const bad: GcpKmsClient = {
      async getPublicKey() { return [{}]; },
      async asymmetricSign() { return [{ signature: Buffer.alloc(0) }]; },
    };
    await expect(createGcpKmsSigner(KV, bad)).rejects.toThrow(/no PEM/i);
  });
});
