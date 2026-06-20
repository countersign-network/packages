/** Venue name -> EVM chain id. Testnet only (prime directive #6). */
export const VENUE_CHAIN_IDS: Readonly<Record<string, number>> = {
  "base-sepolia": 84532,
  "ethereum-sepolia": 11155111,
  "polygon-amoy": 80002,
  "optimism-sepolia": 11155420,
};

export function chainIdFor(venue: string): number | undefined {
  return VENUE_CHAIN_IDS[venue];
}
