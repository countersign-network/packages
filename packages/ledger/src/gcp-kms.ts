/**
 * GCP Cloud KMS ledger signer. The ledger signing key lives in Cloud KMS as an Ed25519
 * ASYMMETRIC_SIGN key (algorithm EC_SIGN_ED25519, "pure" EdDSA over the raw message) and the private
 * key NEVER enters this process — each ledger row is signed by a KMS `asymmetricSign` call, and
 * verification uses the published public key LOCALLY (no KMS round-trip). This is the production
 * posture for prime directive #5: the audit ledger stays forgery-resistant even if the host is popped.
 *
 * The KMS client is INJECTED so @countersign/ledger carries no @google-cloud/kms dependency. The
 * consumer (e.g. main.ts at deploy) does:
 *
 *   import { KeyManagementServiceClient } from "@google-cloud/kms";
 *   const signer = await createGcpKmsSigner(process.env.GCP_KMS_KEY_VERSION!, new KeyManagementServiceClient());
 *
 * Setup: an Ed25519 ASYMMETRIC_SIGN key version + a service account with
 * roles/cloudkms.signerVerifier (sign) and viewer (getPublicKey). See docs/PRODUCTION-READINESS.md.
 */

import { createExternalSigner, type LedgerSigner } from "./hash-chain";

/** The minimal slice of @google-cloud/kms's KeyManagementServiceClient this signer uses. */
export interface GcpKmsClient {
  getPublicKey(request: { name: string }): Promise<[{ pem?: string | null }, ...unknown[]]>;
  asymmetricSign(
    request: { name: string; data: Uint8Array },
  ): Promise<[{ signature?: Uint8Array | string | null }, ...unknown[]]>;
}

/**
 * Build a LedgerSigner backed by a GCP KMS Ed25519 key version. Fetches the public key once (so the
 * ledger can publish it and verify locally); signing always goes to KMS.
 *
 * @param keyVersionName projects/P/locations/L/keyRings/R/cryptoKeys/K/cryptoKeyVersions/V
 */
export async function createGcpKmsSigner(keyVersionName: string, client: GcpKmsClient): Promise<LedgerSigner> {
  const [pub] = await client.getPublicKey({ name: keyVersionName });
  if (!pub.pem) throw new Error("gcp-kms: getPublicKey returned no PEM public key");
  // PEM (SPKI) -> base64 DER, the form the ledger publishes and verifies against.
  const { createPublicKey } = await import("node:crypto");
  const publicKey = createPublicKey(pub.pem).export({ format: "der", type: "spki" }).toString("base64");

  return createExternalSigner({
    publicKey,
    // EC_SIGN_ED25519 is "pure" EdDSA: hand KMS the raw message bytes (no client-side prehash).
    sign: async (message) => {
      const [resp] = await client.asymmetricSign({ name: keyVersionName, data: Buffer.from(message, "utf8") });
      if (!resp.signature) throw new Error("gcp-kms: asymmetricSign returned no signature");
      const sig = typeof resp.signature === "string" ? Buffer.from(resp.signature, "base64") : Buffer.from(resp.signature);
      return sig.toString("hex");
    },
    // verify defaults to a LOCAL Ed25519 check against `publicKey` — no KMS round-trip needed.
  });
}
