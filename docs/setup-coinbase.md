# Coinbase CDP — credentials runbook (Base Sepolia, testnet only)

The 5-minute setup to turn the Coinbase adapter from skeleton → live. Testnet only (prime
directive #6). Full SDK surface: `docs/sdk-research/coinbase.md`. *Vendor UI labels move — if a
screen differs, search the CDP docs.*

## 1. Get the three secrets (CDP Portal — exact flow)

1. Sign in at **portal.cdp.coinbase.com**, verify your email.
2. **API Key ID + Secret:** go to **portal.cdp.coinbase.com/api-keys/secret** → create a new
   **Secret API Key**. Under **Advanced settings**, check **Non-custodial: Export** and
   **Non-custodial: Manage**; keep the algorithm as **Ed25519** (ECDSA is only for the Coinbase
   App / Advanced Trade SDKs). **Download the JSON before closing** — the key ID and private key are
   inside (`CDP_API_KEY_ID`, `CDP_API_KEY_SECRET`).
3. **Wallet Secret:** go to **portal.cdp.coinbase.com/wallets/non-custodial/security** → **Generate
   Wallet Secret**. **Shown exactly once — copy it now** (`CDP_WALLET_SECRET`). It authorizes
   signing; keys themselves stay in Coinbase's TEE (we never hold them).
4. Stay on **Base Sepolia** (testnet). Do not create mainnet keys.

> Reference (Coinbase): https://docs.cdp.coinbase.com/wallets/quickstart/api-key-auth
> Optional — install the CDP docs MCP so I can ground in live docs while wiring the adapter (run it
> yourself in your prompt): `! claude mcp add --transport http coinbase-cdp https://docs.cdp.coinbase.com/mcp`

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

- `pnpm --filter @cosign/provider-coinbase add @coinbase/cdp-sdk viem dotenv` and init `CdpClient`
  from the env (`new CdpClient()` reads the three `CDP_*` vars).
- The quickstart's plain create/fund/send (`createAccount` → `requestFaucet` → `sendTransaction`,
  with a ~3–10s **balance-sync delay** before sending) is the hello-world; Cosign layers the
  governance on top:
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
