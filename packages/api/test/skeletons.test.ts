import { describe, it, expect } from "vitest";
import { CoinbaseProvider } from "@countersign/provider-coinbase";
import { TurnkeyProvider } from "@countersign/provider-turnkey";
import { OpenfortProvider } from "@countersign/provider-openfort";
import { LithicProvider } from "@countersign/provider-lithic";

// All three vendor adapters are now LIVE (testnet). Live calls need credentials, but each must
// CONSTRUCT without credentials so capabilities() stays probe-able offline (the freeze controller
// reads capabilities to plan its fan-out). Real live behaviour is proven by each package's spike.ts.
describe("vendor adapters (live)", () => {
  it("coinbase: real capabilities, constructs without credentials", async () => {
    expect((await new CoinbaseProvider().capabilities()).enforcementMode).toBe("native-session-caps");
  });

  it("turnkey: real capabilities, constructs without credentials", async () => {
    expect((await new TurnkeyProvider().capabilities()).enforcementMode).toBe("pre-sign-policy");
  });

  it("openfort: real capabilities, constructs without credentials", async () => {
    expect((await new OpenfortProvider().capabilities()).enforcementMode).toBe("onchain-policy");
  });

  // The first non-crypto rail: a virtual card under the same control plane.
  it("lithic (card rail): real capabilities, constructs without credentials", async () => {
    const caps = await new LithicProvider().capabilities();
    expect(caps.enforcementMode).toBe("native-session-caps");
    expect(caps.supportsSessionRevocation).toBe(true);
  });
});
