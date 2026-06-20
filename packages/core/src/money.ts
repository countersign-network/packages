/**
 * Money is ALWAYS a string in base units (wei, USDC's 6-dec smallest unit, ...).
 * Never a JS number — see ActionRequest.amount. All comparison/arithmetic goes through
 * BigInt here so the policy compiler and the providers agree on exact integer semantics.
 */

export function toBig(amount: string): bigint {
  // Reject anything that isn't a clean integer string — fail loud, never silently coerce money.
  if (!/^-?\d+$/.test(amount)) {
    throw new TypeError(`amount must be an integer base-unit string, got: ${JSON.stringify(amount)}`);
  }
  return BigInt(amount);
}

/** -1 if a < b, 0 if equal, 1 if a > b. */
export function cmpAmount(a: string, b: string): -1 | 0 | 1 {
  const x = toBig(a);
  const y = toBig(b);
  return x < y ? -1 : x > y ? 1 : 0;
}

export const addAmount = (a: string, b: string): string => (toBig(a) + toBig(b)).toString();
export const lte = (a: string, b: string): boolean => toBig(a) <= toBig(b);
export const gt = (a: string, b: string): boolean => toBig(a) > toBig(b);
