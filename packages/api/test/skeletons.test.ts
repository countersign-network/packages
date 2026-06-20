import { describe, it, expect } from "vitest";
import { NotImplementedError, type EnforcementMode } from "@cosign/core";
import { CoinbaseProvider } from "@cosign/provider-coinbase";
import { TurnkeyProvider } from "@cosign/provider-turnkey";
import { OpenfortProvider } from "@cosign/provider-openfort";

describe("vendor adapter skeletons", () => {
  const cases: { name: string; provider: { id: string; capabilities(): Promise<{ enforcementMode: EnforcementMode }>; freeze(s: { kind: "provider-all" }): Promise<unknown> }; mode: EnforcementMode }[] = [
    { name: "coinbase", provider: new CoinbaseProvider(), mode: "native-session-caps" },
    { name: "turnkey", provider: new TurnkeyProvider(), mode: "pre-sign-policy" },
    { name: "openfort", provider: new OpenfortProvider(), mode: "onchain-policy" },
  ];

  for (const c of cases) {
    it(`${c.name}: capabilities() are real (mode ${c.mode})`, async () => {
      const caps = await c.provider.capabilities();
      expect(caps.enforcementMode).toBe(c.mode);
    });

    it(`${c.name}: live calls throw NotImplementedError until credentials exist`, async () => {
      await expect(c.provider.freeze({ kind: "provider-all" })).rejects.toBeInstanceOf(NotImplementedError);
    });
  }
});
