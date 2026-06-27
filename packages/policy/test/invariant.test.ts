import { describe, it, expect } from "vitest";
import type { EnforcementMode } from "@countersign/core";
import { compile, definePolicy, type UnifiedPolicy } from "@countersign/policy";

/**
 * Invariant #5 (THREAT-MODEL): the compiler must never silently WEAKEN a policy. Every field an
 * operator sets must either be enforced natively by the backend OR be listed in `unsupported`
 * (meaning Countersign enforces it itself). A field that is set but neither enforced nor flagged is a
 * silent gap — something the policy forbids could slip through. This test guards against that.
 *
 * ENFORCEABLE is an INDEPENDENT statement of each backend's capability (the SDK-verified matrix),
 * checked against the compiler's `unsupported` output — so it's not circular with the compiler.
 */
const MODES: EnforcementMode[] = ["native-session-caps", "pre-sign-policy", "onchain-policy"];

const ENFORCEABLE: Record<EnforcementMode, Set<string>> = {
  // Coinbase: caps + allow/deny + venue natively; no inline approval gate.
  "native-session-caps": new Set(["asset", "frozen", "perTxCap", "dailyCap", "allowlist", "denylist", "venues"]),
  // Turnkey: per-tx cap + allow/deny + consensus approval + venue; CEL is stateless so no daily cap.
  "pre-sign-policy": new Set(["asset", "frozen", "perTxCap", "allowlist", "approvalThreshold", "denylist", "venues"]),
  // Openfort: on-chain positive allowlist + per-period spend + venue; no per-tx cap / denylist / approval.
  "onchain-policy": new Set(["asset", "frozen", "allowlist", "dailyCap", "venues"]),
};

const FIELDS = ["perTxCap", "dailyCap", "allowlist", "denylist", "approvalThreshold", "venues", "frozen"] as const;

const POLICIES: UnifiedPolicy[] = [
  definePolicy({ asset: "USDC", perTxCap: "100", dailyCap: "500", allowlist: ["0x000000000000000000000000000000000000000a"], denylist: ["0x000000000000000000000000000000000000000b"], approvalThreshold: "200", venues: ["base-sepolia"], frozen: false }),
  definePolicy({ asset: "USDC", perTxCap: "100" }),
  definePolicy({ asset: "USDC", dailyCap: "500" }),
  definePolicy({ asset: "USDC", allowlist: ["0x000000000000000000000000000000000000000a"] }),
  definePolicy({ asset: "USDC", denylist: ["0x000000000000000000000000000000000000000b"] }),
  definePolicy({ asset: "USDC", approvalThreshold: "200" }),
  definePolicy({ asset: "USDC", venues: ["polygon-amoy"] }),
  definePolicy({ asset: "USDC", frozen: true }),
];

describe("invariant #5 — the compiler never silently drops (weakens) a policy field", () => {
  for (const mode of MODES) {
    it(`[${mode}] every set field is natively enforced OR explicitly unsupported`, () => {
      for (const policy of POLICIES) {
        const native = compile(policy, mode);
        const unsupported = new Set(native.unsupported.map((u) => u.field));
        for (const field of FIELDS) {
          if ((policy as Record<string, unknown>)[field] === undefined) continue;
          const handled = ENFORCEABLE[mode].has(field) || unsupported.has(field);
          expect(handled, `${mode}: '${field}' is set but neither enforced nor flagged unsupported — SILENT WEAKENING`).toBe(true);
        }
      }
    });
  }
});
