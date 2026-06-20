import { describe, it, expect } from "vitest";
import { toBig, cmpAmount, addAmount, lte, gt } from "@cosign/core";

describe("money (base-unit string arithmetic)", () => {
  it("compares large amounts exactly (no float drift)", () => {
    // Beyond Number.MAX_SAFE_INTEGER — must stay exact.
    expect(cmpAmount("9007199254740993", "9007199254740992")).toBe(1);
    expect(cmpAmount("100", "100")).toBe(0);
    expect(cmpAmount("99", "100")).toBe(-1);
  });

  it("adds without losing precision", () => {
    expect(addAmount("9007199254740992", "1")).toBe("9007199254740993");
  });

  it("lte / gt at the boundary", () => {
    expect(lte("100", "100")).toBe(true);
    expect(gt("101", "100")).toBe(true);
    expect(gt("100", "100")).toBe(false);
  });

  it("rejects non-integer / malformed amounts (never coerce money)", () => {
    expect(() => toBig("1.5")).toThrow(TypeError);
    expect(() => toBig("0x10")).toThrow();
    expect(() => toBig("abc")).toThrow();
    expect(() => toBig("")).toThrow();
  });
});
