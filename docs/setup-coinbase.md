# Coinbase CDP — credentials runbook (Base Sepolia, testnet only)

The 5-minute setup to turn the Coinbase adapter from skeleton → live. Testnet only (prime
directive #6). Full SDK surface: `docs/sdk-research/coinbase.md`. *Vendor UI labels move — if a
screen differs, search the CDP docs.*

## 1. Get the three secrets (CDP Portal)

1. Sign in at **portal.cdp.coinbase.com** with your Coinbase account; accept terms.
2. Create (or pick) a **project**.
3. **API keys → Create API key** → a **Secret API Key** (server-side). Copy the **API Key ID** and
   **API Key Secret** — the secret is shown once.
4. Create a **Wallet Secret** (Server Wallets / Wallet API v2 section) — this authorizes signing;
   keys themselves stay in Coinbase's TEE (we never hold them). Copy it.
5. Confirm you're on **Base Sepolia** (testnet). Do not create mainnet keys.

## 2. Put them in `.env`

```bash
cp .env.example .env       # .env is gitignored — never commit it
# then fill:
CDP_API_KEY_ID=...
CDP_API_KEY_SECRET=...
CDP_WALLET_SECRET=...
```

## 3. Fund the test wallet

Use the SDK faucet (`cdp.evm.requestFaucet({ network: "base-sepolia", token: "eth" | "usdc" })`)
or the CDP Portal faucet.

## 4. Hand it to me — what I'll wire (≈ fill-in-the-blanks)

In `packages/providers/coinbase` (per `docs/sdk-research/coinbase.md`):

- `pnpm add @coinbase/cdp-sdk` and init `CdpClient` from the env.
- `provisionWallet` → `createAccount` + `createSmartAccount`.
- `applyPolicy` → the compiler output already maps: daily cap → `createSpendPermission`
  (allowance + periodInDays); per-tx cap + allowlist → `policies.createPolicy` (`ethValue<=`,
  `evmAddress in`).
- `freeze` → `revokeSpendPermission` (idempotent); fail-closed if the userOp can't be confirmed.
- `subscribe` → `webhooks.createSubscription` (+ reconcile the 3-min window).

Then a **Phase-0 spike** on Base Sepolia: provision an agent, apply a cap, let it spend within
policy, **block the next spend via a Cosign freeze**, and **measure the real freeze latency** (the
number that validates the <1s claim under real network + on-chain conditions). This is the
real-backend version of `pnpm demo`.

## Notes

- The `awal` CLI / payments-MCP are email-OTP, end-user tools — not for a headless server adapter.
  We integrate the **SDK**.
- Server Wallet **v2** / `@coinbase/cdp-sdk` only (v1 `@coinbase/coinbase-sdk` deprecated Feb 2026).
