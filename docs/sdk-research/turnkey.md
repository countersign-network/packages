# Turnkey — TS Adapter Integration Reference (verified mid-2026)

> Verified by SDK research, 2026-06-20. Re-verify before live calls.
> Turnkey = TEE-isolated keys + a policy engine evaluated BEFORE signing. Chain-agnostic: it signs;
> your app broadcasts.

## ✅ LIVE & PROVEN against @turnkey/sdk-server v6.1.1 (2026-06-26)

The adapter (`packages/providers/turnkey/src/index.ts`) is wired and proven on live api.turnkey.com.
`smoke.ts` (getWhoami) + `spike.ts` (provision → applyPolicy → agent signs → freeze) both pass; the
agent's in-policy tx is ALLOWED, over-cap is DENIED (`OUTCOME_DENY_IMPLICIT`), and after freeze the
same tx is DENIED (`OUTCOME_DENY_EXPLICIT`). Cross-vendor two-backend freeze (Coinbase+Turnkey) runs
green via `packages/agent-harness/live-freeze.ts` (~437ms window). **v6 deltas vs the v5 notes below:**

- **Constructor unchanged**: `new Turnkey({ defaultOrganizationId, apiBaseUrl, apiPrivateKey, apiPublicKey })`,
  then `.apiClient()`. (`Turnkey` is the export alias for `TurnkeyServerSDK`.)
- **Methods take a single `input` object** (e.g. `createPolicy({ policyName, effect, condition, notes, consensus? })`).
  `notes` is REQUIRED on createPolicy; `condition`/`consensus` optional.
- **Agent model that actually binds**: policies only constrain NON-root users. So provision =
  `createSubOrganization` (root user = US, the parent key, for management) + `createUsers` (the agent
  as a non-root delegated user with its own P-256 key from `@turnkey/crypto` `generateP256KeyPair`).
  Sub-org root users use `v1RootUserParamsV5` → `apiKeys:[{apiKeyName, publicKey, curveType:"API_KEY_CURVE_P256"}]`,
  plus empty `authenticators:[]` and **`oauthProviders:[]`** (renamed from the old `oidcProviders`).
- **Freeze** = `createPolicy({ effect:"EFFECT_DENY", condition:"true", notes })` in the agent's sub-org
  (condition `"true"` is valid CEL and matches every signing activity; deny wins over allow). Reversible
  via `deletePolicy`. `revokeSession` = `deleteUsers({ organizationId: subOrgId, userIds:[agentUserId] })`.
- **Health** = `getWhoami({})` → `{ organizationId, organizationName, userId, username }`.
- **Sign** (raw) = `signTransaction({ signWith: walletAddress, unsignedTransaction: <hex WITHOUT 0x>, type:"TRANSACTION_TYPE_ETHEREUM" })`.
- **GOTCHA — policy propagation**: createPolicy activities complete synchronously, but the policy
  engine is eventually-consistent. The VERY FIRST signing request right after applyPolicy can race
  ahead (`policyEvaluations: []`). A ~3s settle (or retry on empty-evaluations) makes it reliable.

## 1. Install
```bash
npm install @turnkey/sdk-server   # current v5.1.1; wraps @turnkey/http + @turnkey/api-key-stamper
# + a signer adapter for tx assembly, e.g. @turnkey/ethers or @turnkey/solana
```

## 2. Auth / credentials
API keypair (`apiPublicKey`/`apiPrivateKey`, P-256/secp256r1) + `defaultOrganizationId`. Requests are
"stamped" (signed) client-side; the private key never leaves.
```ts
import { Turnkey } from "@turnkey/sdk-server";
const turnkey = new Turnkey({
  defaultOrganizationId: process.env.TURNKEY_ORGANIZATION_ID,
  apiBaseUrl: "https://api.turnkey.com",
  apiPrivateKey: process.env.TURNKEY_API_PRIVATE_KEY,
  apiPublicKey: process.env.TURNKEY_API_PUBLIC_KEY });
const apiClient = turnkey.apiClient();
```
Single endpoint `https://api.turnkey.com` (no separate testnet host). v2.0.0 BREAKING: stamper moved
out of config onto the client.

## 3. Provision: sub-organization + wallet per agent
Each agent wallet = its own sub-org (parent has read, not write). Root API user calls
`createSubOrganization` (`ACTIVITY_TYPE_CREATE_SUB_ORGANIZATION`); create the wallet inline.
```ts
const subOrg = await apiClient.createSubOrganization({
  subOrganizationName: "agent-001",
  rootUsers: [{ userName: "Trading Agent",
    apiKeys: [{ apiKeyName: "Agent API Key", publicKey: agentP256PublicKey }],
    authenticators: [], oidcProviders: [] }],
  rootQuorumThreshold: 1,
  wallet: { walletName: "Agent Wallet", accounts: [{ curve: "CURVE_SECP256K1",
    pathFormat: "PATH_FORMAT_BIP32", path: "m/44'/60'/0'/0/0", addressFormat: "ADDRESS_FORMAT_ETHEREUM" }] }});
```

## 4. Policy engine — THE KEY PART
JSON policies evaluated INSIDE the enclave before any signature — cannot be bypassed from app code.
Fields: `effect` (`EFFECT_ALLOW`/`EFFECT_DENY`), `consensus` (who/how many approvers),
`condition` (when it applies), `policyName`, `notes`.
Evaluation: root-quorum overrides → any matching `EFFECT_DENY` wins → ≥1 `EFFECT_ALLOW` permits →
else implicit deny. Strongly typed, no short-circuit (a clause error ⇒ deny). CEL-based.
Roots: `activity.*`, `approvers`, `credentials`, `eth.tx.*` (`.to .value .nonce .chain_id .data
.function_name .contract_call_args[...]`), plus `solana.tx.*`/`tron.tx.*`/`bitcoin.tx.*`.
```
"condition": "eth.tx.value < 1000000000000000000"           // per-tx cap (wei)
"condition": "eth.tx.to in ['0xAAA','0xBBB']"               // allowlist
"condition": "eth.tx.to != '0xBLOCKED'"                     // denylist
"condition": "eth.tx.chain_id == 11155111"                  // scope to a testnet
"consensus": "approvers.any(u, u.id == '<AGENT_USER_ID>')"
```
```ts
await apiClient.createPolicy({ policyName: "Cap + allowlist", effect: "EFFECT_ALLOW",
  consensus: `approvers.any(u, u.id == '${agentUserId}')`,
  condition: `eth.tx.to == '${TREASURY}' && eth.tx.value < 1000000000000000000`, notes: "guardrail" });
```
Also `createPolicies` (batch), `updatePolicy`, `deletePolicy`.

## 5. Delegated / agent signing
Agent = its own user in the sub-org with its own P-256 key and ZERO permissions by default; grant via
policies. Agent gets signatures, never the key. Each request policy-evaluated in-enclave (sub-100ms).
```ts
import { TurnkeySigner } from "@turnkey/ethers";
const agent = new Turnkey({ apiBaseUrl: "https://api.turnkey.com",
  apiPublicKey: process.env.AGENT_PUBLIC_KEY, apiPrivateKey: process.env.AGENT_PRIVATE_KEY,
  defaultOrganizationId: subOrgId });
const signer = new TurnkeySigner({ client: agent.apiClient(), organizationId: subOrgId, signWith: walletAddress });
await signer.connect(provider).sendTransaction({ to: TREASURY, value: ethers.parseEther("0.1") });
```
Raw: `signTransaction` (`ACTIVITY_TYPE_SIGN_TRANSACTION_V2`; `type` ∈ TRANSACTION_TYPE_ETHEREUM/_SOLANA/…),
`signRawPayload(s)`. Helpers: `fetchOrCreateP256ApiKeyUser`, `fetchOrCreatePolicies`.

## 6. Pre-sign approval gating (hold pending external approve/deny) — YES, via consensus
A submission returns an Activity → ALLOW / DENY / **REQUIRES_CONSENSUS**. If a consensus policy needs
more approvers, status = `ACTIVITY_STATUS_CONSENSUS_NEEDED` and **no signature is produced yet**.
Response carries `canApprove`, `canReject`, `votes[]`, `fingerprint`.
```
"consensus": "approvers.any(u,u.id=='<AGENT_ID>') && approvers.any(u,u.id=='<HUMAN_ID>')",
"condition": "activity.action == 'SIGN'", "effect": "EFFECT_ALLOW"
```
Requester's submission = first approval, starts a 24h window. Second approver approves/rejects the
pending activity by `fingerprint`. Exact SDK method to cast the vote UNVERIFIED (mechanism confirmed:
poll activity, submit approval referencing `fingerprint`; `votes[]` tracks each).

## 7. Freeze / revoke (fastest first)
1. `deleteApiKeys` (`ACTIVITY_TYPE_DELETE_API_KEYS`) — kills auth immediately. **Fastest.**
2. `deleteUsers` (`ACTIVITY_TYPE_DELETE_USERS`) — removes the account.
3. `createPolicy` `EFFECT_DENY` — blocks signing, preserves user/keys for audit.

## 8. Events / observability
Webhooks (push) + polling.
```ts
await apiClient.createWebhookEndpoint({ organizationId, name: "Activity updates", url: webhookUrl,
  subscriptions: [{ eventType: "ACTIVITY_UPDATES" }] });
```
A parent-org endpoint receives events for parent AND all sub-orgs. Payload = full activity object;
idempotency via activity `id` / `X-Turnkey-Event-Id`. **Ed25519-signed** — verify `X-Turnkey-Signature`
(`-Algorithm: ed25519`, `-Version: v1`). Poll: `getActivity(id)` for status transitions
(`PENDING → CONSENSUS_NEEDED → COMPLETED/FAILED`). Tamper-proof audit log of all actions.

## 9. Testnet
Turnkey only signs; chain-agnostic. Assemble unsigned tx for any chain (e.g. Sepolia `chain_id 11155111`),
get the signature, broadcast yourself. Scope policies by chain id.

## 10. Gotchas / 2026 changes
- v5.x: v2.0.0 stamper-on-client; v4.0.0 auth restructure (`otpLogin`, `oauthLogin`); v5.0.0 `appName`
  now required in `emailCustomization` + top-level OTP intent; activity versions bumped.
- Activity types are versioned — target the latest (`..._V2`); SDK method names are stable.
- Policies don't short-circuit & are strongly typed — a bad clause ⇒ deny.
- DA users start with zero permissions — forgetting an `EFFECT_ALLOW` ⇒ every signing request fails closed.
- UNVERIFIED: exact consensus-vote method name; webhook decision field (read from activity `status`/`votes`).

## Adapter mapping (EnforcementMode = pre-sign-policy, supportsInlineApproval=true)
| Neutral verb | Turnkey call |
|---|---|
| provisionWallet | createSubOrganization (+ inline wallet) → fetchOrCreateP256ApiKeyUser |
| applyPolicy | createPolicy (EFFECT_ALLOW + eth.tx.value < cap && eth.tx.to in [...]) |
| evaluate → needs_approval | consensus policy ⇒ ACTIVITY_STATUS_CONSENSUS_NEEDED |
| approve/deny | approve/reject pending activity by fingerprint |
| sign | signTransaction / signRawPayload |
| freeze | deleteApiKeys (fast) or EFFECT_DENY policy |
| revokeSession | deleteUsers |
| subscribe | createWebhookEndpoint(ACTIVITY_UPDATES, verify Ed25519) or poll getActivity |

Docs: `docs.turnkey.com/sdks/javascript-server` · `/concepts/policies/{overview,language,examples/ethereum}`
· `/features/policies/delegated-access/agentic-wallets` · `/developer-reference/webhooks`
· `/api-reference/activities/sign-transaction` · `/changelogs/sdk-server/readme`.
