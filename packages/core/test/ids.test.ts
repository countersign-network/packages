import { describe, it, expect, beforeEach } from "vitest";
import { nextId, __resetIdSeq, asAgentId, asProviderId } from "@countersign/core";

describe("branded ids", () => {
  beforeEach(() => __resetIdSeq());

  it("nextId is monotonic and prefixed (reproducible — no Math.random)", () => {
    expect(nextId("frz")).toBe("frz_000001");
    expect(nextId("frz")).toBe("frz_000002");
    expect(nextId("agent")).toBe("agent_000003");
  });

  it("cast helpers are identity at runtime", () => {
    expect(asAgentId("a")).toBe("a");
    expect(asProviderId("coinbase")).toBe("coinbase");
  });
});
