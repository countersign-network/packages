/** Thrown by adapter skeletons whose live SDK calls aren't wired yet (no credentials). */
export class NotImplementedError extends Error {
  constructor(what: string) {
    super(`${what} is not implemented yet — needs vendor credentials. See docs/sdk-research/.`);
    this.name = "NotImplementedError";
  }
}

/**
 * Raised when an enforcement backend cannot CONFIRM a fail-closed action (applyPolicy that
 * can't confirm the new policy is live; a freeze that can't confirm the stop). The caller
 * must treat the agent as still dangerous — never assume the looser/old state is fine.
 */
export class FailClosedError extends Error {
  constructor(
    message: string,
    readonly providerId?: string,
  ) {
    super(message);
    this.name = "FailClosedError";
  }
}
