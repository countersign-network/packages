import { describe, it, expect } from "vitest";
import { NotImplementedError, type EnforcementMode } from "@cosign/core";
import { CoinbaseProvider } from "@cosign/provider-coinbase";
import { TurnkeyProvider } from "@cosign/provider-turnkey";
import { OpenfortProvider } from "@cosign/provider-openfort";

describe("vendor adapters", () => {
  // Coinbase is now a LIVE adapter (real Base Sepolia); its live calls need credentials, not stubs.
  it("coinbase: real capabilities, constructs without credentials", async () => {
    const caps = await new CoinbaseProvider().capabilities();
    expect(caps.enforcementMode).toBe("native-session-caps");
  });

  // Turnkey + Openfort remain skeletons until their SDKs are wired.
  const skeletons: { name: string; provider: { capabilities(): Promise<{ enforcementMode: EnforcementMode }>; freeze(s: { kind: "provider-all" }): Promise<unknown> }; mode: EnforcementMode }[] = [
    { name: "turnkey", provider: new TurnkeyProvider(), mode: "pre-sign-policy" },
    { name: "openfort", provider: new OpenfortProvider(), mode: "onchain-policy" },
  ];

  for (const c of skeletons) {
    it(`${c.name}: capabilities() are real (mode ${c.mode})`, async () => {
      expect((await c.provider.capabilities()).enforcementMode).toBe(c.mode);
    });
    it(`${c.name}: live calls throw NotImplementedError until credentials exist`, async () => {
      await expect(c.provider.freeze({ kind: "provider-all" })).rejects.toBeInstanceOf(NotImplementedError);
    });
  }
});
