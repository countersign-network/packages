/**
 * Deterministic control surface for the MockProvider. Tests and the demo drive exact behavior —
 * including every fail-closed path — without any flakiness.
 */
export interface MockScenario {
  /** What applyPolicy does. "unconfirmed"/"timeout" THROW (per the fail-closed contract). Default "confirm". */
  applyPolicy?: "confirm" | "unconfirmed" | "timeout";
  /**
   * What freeze does. "confirm" actually stops the agent and returns confirmed:true.
   * "unconfirmed" returns confirmed:false WITHOUT stopping it (the dangerous case).
   * "timeout" never resolves (the controller bounds it). Default "confirm".
   */
  freeze?: "confirm" | "unconfirmed" | "timeout";
  /** What revokeSession (the harder kill) does. Default "confirm". */
  revoke?: "confirm" | "fail" | "hang";
  /** Backend health. Default "ok". */
  health?: "ok" | "degraded" | "down";
  applyPolicyDelayMs?: number;
  freezeDelayMs?: number;
  revokeDelayMs?: number;
}

export const DEFAULT_SCENARIO: Required<Pick<MockScenario, "applyPolicy" | "freeze" | "revoke" | "health">> = {
  applyPolicy: "confirm",
  freeze: "confirm",
  revoke: "confirm",
  health: "ok",
};
