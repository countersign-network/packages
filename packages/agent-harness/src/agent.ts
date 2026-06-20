/**
 * A reference spending agent — the "real" thing the control plane governs. It just tries to spend;
 * whether a spend is allowed, blocked, or needs approval is decided by policy + the backend, and
 * every attempt lands in the unified ledger.
 */

import type { AgentId } from "@cosign/core";
import type { SpendAttempt } from "@cosign/policy";
import type { MockProvider, SpendResult } from "@cosign/provider-mock";

export class SpendingAgent {
  constructor(
    readonly label: string,
    private readonly provider: MockProvider,
    readonly agentId: AgentId,
  ) {}

  attempt(attempt: SpendAttempt): Promise<SpendResult> {
    return this.provider.attemptSpend(this.agentId, attempt);
  }
}
