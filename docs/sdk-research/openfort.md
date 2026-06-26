# Openfort — TS Adapter Integration Reference (verified mid-2026)

> Verified by SDK research, 2026-06-20. Re-verify before live calls.
> Openfort = open-source, self-hostable (OpenSigner, MIT), ERC-4337 / EIP-7702 smart accounts with
> ON-CHAIN session-key policy. "On-chain policy" lives in the EIP-7702 Delegator contract
> (`openfort-xyz/openfort-7702-account`) and is exposed via the Sessions API.
> ⚠️ The node SDK had a BREAKING v0.10 redesign — old `players.create()` code is gone.

## ✅ LIVE & PROVEN against @openfort/openfort-node v0.10.5 (2026-06-26)

The adapter (`packages/providers/openfort/src/index.ts`) is wired and proven on live api.openfort.io.
`smoke.ts` (create+delete a backend wallet) + `spike.ts` (provision → applyPolicy → sign → freeze →
sign) both pass: the backend wallet signs before the freeze and the same request fails after
("Account does not exist"). The three-vendor freeze (Coinbase+Turnkey+Openfort) runs green via
`packages/agent-harness/live-freeze.ts` (~697ms total, < 1s, ledger verified). **v0.10.5 specifics:**

- **Constructor**: `new Openfort(secretKey, { walletSecret })` — `Openfort` is both the default and a
  named export. `OpenfortOptions = { basePath?, walletSecret?, debugging?, publishableKey? }`.
- **Creds for the BACKEND agent-wallet path**: `OPENFORT_SECRET_KEY` (sk_test_ for testnet) +
  `OPENFORT_WALLET_SECRET`. No publishable key / Shield keys needed for backend wallets.
- **⚠️ WALLET SECRET FORMAT GOTCHA**: the dashboard/CLI hands you a **PEM file** with a PUBLIC KEY
  block AND a PRIVATE KEY block. `OPENFORT_WALLET_SECRET` is the **base64 DER body of the PRIVATE KEY
  block** — strip the `-----BEGIN/END PRIVATE KEY-----` headers and all newlines (~184 chars, starts
  with `MIG` = PKCS#8 DER). Passing the whole PEM (or with newlines) → "Invalid wallet secret format:
  Could not create the EC key". This is base64-encoded EC P-256 private key in DER format.
- **Provision** = `accounts.evm.backend.create()` → `EvmAccount { id: "acc_…", address, custody, walletId }`.
  Backend wallets are chain-agnostic EOAs in Openfort's TEE (no chainId needed at create).
- **Sign** = `accounts.evm.backend.sign({ id, data })` (data = hex hash) or the account object's
  `.sign({ hash })` / `.signMessage({ message })`.
- **Freeze (v1, custody-level)** = `accounts.evm.backend.delete(accountId)` → `{ deleted: true }`;
  the signer is destroyed, so signing fails after — a confirmed kill. (Irreversible: a reversible
  freeze needs the on-chain `update`→delegated + session-key + KeysManager `pauseKey`/`unpauseKey`.)
- **Health** = `accounts.evm.backend.list({ limit: 1 })`.
- **Build note**: the package ships a prebuilt `dist`; its only install script is `only-allow pnpm`.
  pnpm 11 requires an explicit decision → set `allowBuilds: { '@openfort/openfort-node': false }` in
  pnpm-workspace.yaml (no build needed), else `pnpm typecheck`'s deps-check errors.
- **Hardening (the real on-chain guard, future)**: `accounts.evm.backend.update` (EOA→EIP-7702
  delegated) + `sessions.create` (scoped session key) + KeysManager `setCanCall`/`setTokenSpend` and
  `pauseKey`/`revokeKey` verified by `isKeyActive`. v1 keeps per-tx caps Cosign-layer.

## 1. Install (server/backend TS SDK)
```bash
npm install @openfort/openfort-node   # v0.10.5; Node 18+; MIT
# client: @openfort/openfort-js ; React: openfort-kit
```

## 2. Auth / credentials + init (v0.10 current)
Secret key `sk_test_...`/`sk_live_...` (server) + publishable `pk_...` (client) + a `walletSecret`
for server signing. API base `https://api.openfort.io/v1`.
```ts
import Openfort from "@openfort/openfort-node";
const openfort = new Openfort("sk_test_...", { walletSecret: "your-wallet-secret" });
```

## 3. Provision (smart account / agent account on testnet) — v0.10
```ts
const account = await openfort.accounts.evm.backend.create(); // also .import({privateKey}), .solana.backend.create()
console.log(account.address);
```
⚠️ v0.10 reorganized around `accounts.evm/solana.backend` and folded identity into `openfort.iam`
(`iam.users.list`, `iam.getSession`). Treat any `players` code as legacy (alias UNVERIFIED). Testnet by
`chainId`: Base Sepolia `84532`, Polygon Amoy `80002`.

## 4. Session keys — ON-CHAIN policy (the key part)
API surface (`openfort.sessions` / `POST /v1/sessions`):
```ts
const sessionKey = generatePrivateKey();
const addr = privateKeyToAccount(sessionKey).address;
const session = await openfort.sessions.create({ account: "acc_...", address: addr, chainId: 80002,
  validAfter: 0, validUntil: 1685004600, policy: "pol_..." }); // policy = gas-sponsorship policy
// OWNER must authorize: sign session.nextAction.payload.signableHash, then:
await openfort.sessions.signature(session.id, { signature: SIGNED_HASH });
```
EIP-7715 scoped permissions (contract allowlist + calls + spend policies) granted client-side via
`wallet_grantPermissions` (`type:'contract-call'`, `data.address`, `data.calls`, `policies`, `expiry`).

**On-chain enforcement (`openfort-7702-account`, `src/core/KeysManager.sol`):**
Account implements ERC-4337 (validates in `_validateSignature(PackedUserOperation, userOpHash)`),
ERC-1271, ERC-7821 (batch), ERC-7201. (ERC-7579 modularity = marketing claim, UNVERIFIED in this repo;
EIP-7715 is the off-chain request format, not on-chain here.)
- Register: `registerKey(IKey.KeyDataReg)` — `{ keyType, validUntil, validAfter, limits (tx-count quota),
  key, keyControl }`. `KeyType { EOA, WEBAUTHN, P256, P256NONKEY }`, `KeyControl { Self, Custodial }`.
- Allowlist: `setCanCall(bytes32 keyId, address target, bytes4 funSel, bool can)` / `hasCanCall(...)`.
- Spend (per period): `setTokenSpend(bytes32 keyId, address token, uint256 limit, SpendPeriod period)`
  / `updateTokenSpend` / `removeTokenSpend` / `clearSpendPermissions`.
- Validity: `validAfter`/`validUntil` (uint48); `updateKeyData(keyId, validUntil, limits)`.
Enforcement happens inside ERC-4337 `validateUserOp`/`_validateSignature` — even a compromised backend
acts only within scope until expiry.

## 5. Spend (tx signed by the session key)
```ts
const intent = await openfort.transactionIntents.create({ account: "acc_...", chainId: 80002,
  policy: "pol_...", optimistic: false,
  interactions: [{ contract: "con_...", functionName: "transfer", functionArgs: [to, amount] }] });
const signature = await sessionAccount.signMessage({ message: { raw: intent.nextAction.payload.signableHash } });
// submit signature back to the intent to broadcast
```
⚠️ Exact v0.10 path for `transactionIntents.*`/`sessions.*` UNVERIFIED (blog uses these; v0.10 README
documents accounts/policies/feeSponsorship/iam explicitly).

## 6. Freeze / revoke (on-chain guard path)
API: `openfort.sessions.revoke({ account, address, chainId, policy })` (owner signs returned hash).
On-chain (KeysManager): hard `revokeKey(bytes32 keyId)` (emits `KeyRevoked`); soft freeze/unfreeze
`pauseKey(keyId)` / `unpauseKey(keyId)`; scope teardown `clearExecutePermissions(keyId)` /
`clearSpendPermissions(keyId)`. Check with `isKeyActive(keyId)`.
> Adapter "freeze" → `pauseKey` (+ verify `isKeyActive`); adapter "kill" → `revokeKey`.
> Drive the on-chain method and verify; don't trust the API call resolving alone.

## 7. Events / webhooks
Webhooks for tx states: successful/failed/cancelled/broadcasted (`transaction_intent.successful`, …) +
balance events. Configured in Dashboard; also a pollable Events API. Real-time push. Exact subscription
endpoint / Svix backing UNVERIFIED.

## 8. Self-hosting / OpenSigner
OpenSigner = MIT TEE/enclave signer, self-hostable. Changes only the signing/RPC endpoint + key custody,
not the API shape (`sessions`/`transactionIntents`/`KeysManager` unchanged).

## 9. Testnet
Base Sepolia `84532` and Polygon Amoy `80002`. ERC-4337 smart accounts all chains (EntryPoint v0.6);
EIP-7702 delegated accounts on Arbitrum/Base/BNB/Ethereum/Optimism/Polygon (EntryPoint v0.8/v0.9).

## 10. Gotchas / 2026 changes
- BREAKING v0.10 redesign: namespaced API, default export, `{ walletSecret }` constructor. Old flat
  `players`/`accounts.create` examples won't compile.
- Backend wallets = EOAs in Openfort's TEE (sub-200ms), distinct from on-chain smart accounts —
  don't conflate "backend wallet" (custody) with "smart account/delegator" (policy).
- Standards: ERC-4337 (+EntryPoint), EIP-7702, ERC-1271/7821/7201/777. EIP-7715 = off-chain request.
  ERC-7579 UNVERIFIED in the 7702 contract repo.
- Two revoke layers (API `sessions.revoke` vs on-chain `revokeKey`/`pauseKey`) — for a true on-chain
  guard drive the contract method and verify `isKeyActive`.
- Gas-sponsorship `policy` (pol_...) is orthogonal to session-key permission scope.

## Adapter mapping (EnforcementMode = onchain-policy, supportsOnchainGuard=true)
| Neutral verb | Openfort call |
|---|---|
| provisionWallet | accounts.evm.backend.create |
| applyPolicy | sessions.create + KeysManager.setCanCall / setTokenSpend (on-chain scope) |
| spend | transactionIntents.create (signed by session key) |
| freeze | KeysManager.pauseKey (+ verify isKeyActive) / API sessions.revoke |
| revokeSession (kill) | KeysManager.revokeKey |
| subscribe | webhooks (Dashboard) + Events API poll |

Docs: `github.com/openfort-xyz/openfort-node` · `npmjs.com/package/@openfort/openfort-node`
· `openfort.io/docs/products/embedded-wallet/javascript/smart-wallet/advanced/session-keys`
· `github.com/openfort-xyz/openfort-7702-account` · `openfort.io/docs/configuration/chains`.
