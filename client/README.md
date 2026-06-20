# Cosign Client (Flutter) — Phase 3 scaffold

The client is intentionally **thin and key-less**: a renderer over the Core API
(`packages/api`). It holds no wallet SDKs and no keys — a compromised client still cannot move
funds or weaken policy, because the trust boundary IS the Dart/TS language boundary.

**This is a scaffold for Phase 3, deliberately not built yet.** When it's time:

1. The contract is already locked in `../api-contract/` — `openapi.yaml` (REST) + `index.ts`
   (`WsServerMessage` for the ws stream). Treat it as the source of truth.
2. Generate the Dart client from `openapi.yaml` (e.g. `openapi-generator` `dart-dio`), and mirror
   `WsServerMessage` for the `/events` websocket.
3. Build the surfaces from the handoff: policy editor, live multi-venue monitor, the big red
   **FREEZE** button, ledger view, approval prompts.
4. Wire **FCM/APNs** early — the approval prompt and the on-the-go kill switch live on the phone; a
   freeze alert that arrives 30 seconds late is a failed product.

Run the Core it talks to: `pnpm --filter @cosign/api start` (defaults to `http://localhost:8080`,
ws at `ws://localhost:8080/events`).
