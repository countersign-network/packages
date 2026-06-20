/**
 * Branded identifier types. Brands prevent accidentally passing an AgentId where a
 * ProviderId is expected — a real class of bug once three backends are in play.
 *
 * These are zero-cost at runtime (just strings); the brand exists only in the type system.
 */

export type ProviderId = string & { readonly __brand: "ProviderId" };
export type AgentId = string & { readonly __brand: "AgentId" };
export type SessionId = string & { readonly __brand: "SessionId" };

/** chain / network / venue, e.g. "base-sepolia" */
export type Venue = string;

export const asProviderId = (s: string): ProviderId => s as ProviderId;
export const asAgentId = (s: string): AgentId => s as AgentId;
export const asSessionId = (s: string): SessionId => s as SessionId;

/**
 * Deterministic-friendly id mint. We avoid Math.random / Date.now in library code so the
 * demo and tests stay reproducible; callers that want randomness pass their own suffix.
 */
let __seq = 0;
export const nextId = (prefix: string): string => `${prefix}_${(++__seq).toString(36).padStart(6, "0")}`;

/** Reset the internal counter — test helper only. */
export const __resetIdSeq = (): void => {
  __seq = 0;
};
