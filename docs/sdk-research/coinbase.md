# Coinbase Agentic Wallets — TS Adapter Integration Reference (verified mid-2026)

> Verified by SDK research, 2026-06-20. Re-verify before writing live calls — Coinbase ships fast.
> Coinbase ships TWO surfaces: (A) programmatic `@coinbase/cdp-sdk` (the adapter target) and
> (B) the `awal` CLI / `@coinbase/payments-mcp` MCP server (opinionated end-user/agent tooling,
> email-OTP auth, NOT a programmatic API). Build the neutral adapter against the SDK.

## 1. Install
```bash
npm install @coinbase/cdp-sdk dotenv
```
`@coinbase/cdp-sdk` (latest line ~v1.40–1.46, Apr 2026). viem-compatible.
x402 client packages (separate): `@x402/axios`, `@x402/evm`, `@x402/svm`, `@modelcontextprotocol/sdk`.

## 2. Auth / credentials
Three secrets from the CDP Portal: **API Key ID**, **API Key Secret**, **Wallet Secret** (the
Wallet Secret signs; keys stay in a TEE).
```ts
import { CdpClient } from "@coinbase/cdp-sdk";
import dotenv from "dotenv"; dotenv.config();
const cdp = new CdpClient(); // reads CDP_API_KEY_ID, CDP_API_KEY_SECRET, CDP_WALLET_SECRET
```

## 3. Provision an agent wallet on Base Sepolia
```ts
const account = await cdp.evm.createAccount();
const smartAccount = await cdp.evm.createSmartAccount({ owner: account }); // needed for spend permissions
```
(`createSmartAccount` arg shape UNVERIFIED — confirm against the TS API ref / examples dir.)

## 4. Session keys / spend caps / allowlists — MOST IMPORTANT (TWO mechanisms)
### 4a. Spend Permissions (token allowance + period/daily cap, on smart accounts)
```ts
const { userOpHash } = await cdp.evm.createSpendPermission({ network: "base-sepolia", spendPermission });
const permissions = await cdp.evm.listSpendPermissions({ address: smartAccount.address });
```
`SpendPermissionInput`: `account` (granting smart account), `spender` (the authorized signer /
"session key" address), `token` (address or `"usdc"`/`"eth"`), `allowance` (max, smallest units),
`periodInDays` (e.g. `1` = daily cap), or `period`/`start`/`end`. Remaining allowance read via
`getCurrentPeriod` on Spend Permission Manager `0xf85210B21cC50302F477BA56686d2019dC9b67Ad`.
**Gotcha: period caps only — NO standalone per-tx cap here.** Per-tx caps come from the Policy engine.

### 4b. Policy engine (per-tx value cap + recipient allowlist + network restriction)
```ts
const policy = await cdp.policies.createPolicy({ policy: {
  scope: "account", description: "agent guardrails",
  rules: [{ action: "accept", operation: "signEvmTransaction", criteria: [
    { type: "ethValue", ethValue: "2000000000000000000", operator: "<=" }, // per-tx cap (wei)
    { type: "evmAddress", addresses: ["0x..."], operator: "in" },           // recipient allowlist
    { type: "evmNetwork", networks: ["base-sepolia"], operator: "in" },
  ]}],
}});
```
Rules evaluate top-down, first match wins. Criteria: `ethValue` (`<=`), `evmAddress` (`in`/`not in`),
`evmNetwork` (`in`). Attaching policy to an account (`createAccount({ accountPolicy })` vs
`updateAccount`) UNVERIFIED.

> Adapter mapping: "session key" = a `spender` granted a Spend Permission (allowance + daily cap)
> AND governed by an account Policy (per-tx cap + allowlist). No single `createSessionKey()` exists.

## 5. Spend / x402
```ts
const { transactionHash } = await cdp.evm.sendTransaction({
  address: account.address, network: "base-sepolia",
  transaction: { to: "0x...", value: parseEther("0.000001") } });
```
x402 v2: `x402Client()` + `registerExactEvmScheme(client, { signer })` + `wrapAxiosWithPayment(axios, client)`.

## 6. Freeze / revoke (hard-stop)
```ts
const { userOpHash } = await cdp.evm.revokeSpendPermission({
  address: smartAccount.address, permissionHash, network: "base-sepolia" });
```
REST: `POST /v2/evm/smart-accounts/{address}/spend-permissions/revoke` (supports `X-Idempotency-Key`).
Also: attach/replace a Policy whose first rule is `{ action: "reject", operation: "signEvmTransaction" }`.

## 7. Events — push (webhooks only, NO websockets)
```ts
await cdp.webhooks.createSubscription({ description: "...", eventTypes: [
  "wallet.transaction.confirmed", "wallet.delegation.revoked"], targetUrl: "https://your.app/hook",
  isEnabled: true });
```
Event types: `wallet.transaction.{created,signed,broadcast,pending,confirmed,failed,replaced}`,
`wallet.typed_data.signed`, `wallet.message.signed`, `wallet.hash.signed`,
`wallet.delegation.{created,revoked}`. At-least-once; monitoring window 3 min EVM / 2 min Solana
(beyond that, reconcile/poll). Verify payloads with the subscription `secret`.

## 8. x402 + MCP (Claude angle)
x402 = HTTP 402 USDC micropayments, native to agentic wallets. MCP server
`npx @coinbase/payments-mcp` (stdio) is compatible with Claude Desktop/Code, Codex, Gemini CLI —
balance/address/discover/pay only (NO send/trade); email-OTP auth ⇒ unsuitable for headless adapters.

## 9. Testnet / faucet
Base Sepolia confirmed (`network: "base-sepolia"`; CAIP-2 `eip155:84532`).
```ts
await cdp.evm.requestFaucet({ address: account.address, network: "base-sepolia", token: "eth" }); // or "usdc"
```

## 10. Gotchas / 2026 changes (will break old code)
- **Server Wallet v1 / `@coinbase/coinbase-sdk` deprecated Feb 2 2026** → use v2 / `@coinbase/cdp-sdk`.
- `@coinbase/cdp-agentkit-core` deprecated → `@coinbase/agentkit`.
- **x402 v1→v2 package + API rename** (major): `x402-axios`→`@x402/axios`, etc.; network is now CAIP-2.
- Spend Permissions require a smart account, return a `userOpHash` (not an L1 tx hash).
- **Per-tx caps live in the Policy engine, not Spend Permissions** (common mistake).
- `awal` CLI exposes no spend-limit/session-key/freeze subcommands — demo only, not an API.
- UNVERIFIED: `createSmartAccount` arg shape; policy-to-account attachment field; whether a
  first-class `createSessionKey()` exists. Confirm at `coinbase.github.io/cdp-sdk/typescript/`.

## Adapter mapping (EnforcementMode = native-session-caps, realtimeEvents=false)
| Neutral verb | Coinbase call |
|---|---|
| provisionWallet | createAccount + createSmartAccount |
| applyPolicy (daily cap) | createSpendPermission(allowance, periodInDays) |
| applyPolicy (per-tx cap + allowlist) | policies.createPolicy(ethValue<=, evmAddress in, evmNetwork in) |
| freeze | revokeSpendPermission (idempotent) OR reject-all Policy |
| subscribe | webhooks.createSubscription (poll/reconcile; no ws) |

Docs: `docs.cdp.coinbase.com/wallet-api/v2/introduction/quickstart` · `/wallets/using-wallets/spend-permissions`
· `/server-wallets/v2/using-the-wallet-api/policies/evm-policies` · `/data/webhooks/cdp-wallet-webhooks`
· `/x402/migration-guide` · TS ref `coinbase.github.io/cdp-sdk/typescript/`.
