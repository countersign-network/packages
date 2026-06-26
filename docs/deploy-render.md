# Deploy the Countersign Core on Render

One-click-ish deploy of the hosted free-tier Core (the playground `countersign-mcp` + the dashboard point
at). Uses `render.yaml` (Blueprint / IaC).

## Deploy

1. Push is already on GitHub. In Render: **New → Blueprint → connect `simoncrean/countersign`**.
2. Render reads `render.yaml` and provisions:
   - **`countersign-core`** — an always-on web service (`pnpm --filter @countersign/api start`), health-checked
     at `/health`, auto-deploying on push to `main`. TLS + a `*.onrender.com` URL are automatic.
   - **`countersign-ledger`** — a managed Postgres; `DATABASE_URL` is injected into the web service, so the
     hash-chained ledger is **durable** (survives restarts).
3. Apply. First deploy builds with `corepack enable && pnpm install --frozen-lockfile`.

## After it's up

- Open the service URL → the **dashboard** (FREEZE button, live ledger, approvals).
- `GET /health`, `GET /ledger` (verified hash chain), `POST /freeze`.
- Point the MCP server at it: `COUNTERSIGN_URL=https://countersign-core-xxxx.onrender.com` (remote mode).

## Settings that matter

- **Always-on (do not use the free web plan):** the free plan sleeps on idle, and a sleeping control
  plane can't freeze. `starter` (~$7/mo) is the floor. (Same reason to avoid scale-to-zero anywhere.)
- **DB plan:** `basic-256mb` for persistence; `free` is fine to trial but is deleted after ~30 days.
  The ledger is your compliance artifact — keep backups on a paid plan in real use.
- **`COUNTERSIGN_DEMO_TRAFFIC`:** `on` deploys the demo Core (mock fleet + synthetic spends, good for a
  public playground). Set **`off`** for a real Core serving actual agents (then wire real adapters +
  creds; see `setup-coinbase.md`).
- **Region:** set close to your users; revisit if global freeze latency becomes a measured concern.
- Verify Render's plan slugs in the dashboard before applying — they change.

## Portability

The Core is standard Node + standard Postgres (no Render-specific primitives), so this is reversible:
a `fly.toml` (app) + Supabase/Neon (DB) is a drop-in swap if you later want multi-region edge.
