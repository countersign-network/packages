/**
 * The Core HTTP + websocket server — the only thing the (key-less) client talks to. REST mirrors
 * openapi.yaml; the ws stream pushes WsServerMessage. Implemented on node:http + ws to keep the
 * dependency surface tiny for the proof.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import { asAgentId } from "@countersign/core";
import { parsePolicy } from "@countersign/policy";
import {
  WS_PATH,
  type AgentsResponse,
  type ApplyPolicyRequest,
  type ApproveRequest,
  type DenyRequest,
  type EvaluateRequest,
  type FreezeRequest,
  type HealthResponse,
  type LedgerRecordDTO,
  type LedgerResponse,
  type WsServerMessage,
} from "@countersign/api-contract";
import { CountersignCore } from "./core-service";
import { backendsView, connectBackend, metricsOf } from "./connect";
import type { CoreResolver } from "./tenants";
import type { IssuedKey, KeyStore } from "./keystore";

export interface CountersignServer {
  http: Server;
  listen(port?: number): Promise<number>;
  close(): Promise<void>;
}

// The first-demo web dashboard (handoff: "a plain web dashboard is fine for the very first demo").
const DASHBOARD_HTML = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "dashboard.html"), "utf8");

// Self-serve "get your key" page (GET /start). One click → POST /signup → a key + the MCP config.
const START_HTML = `<!doctype html><html lang="en"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>Get your Countersign key</title>
<style>
 :root{--bg:#0b1020;--card:#131c3a;--line:#243056;--fg:#eaf0ff;--muted:#9fb0d6;--brand:#7c9cff;--accent:#58e6a8}
 *{box-sizing:border-box}body{margin:0;background:radial-gradient(900px 500px at 70% -10%,#16224a,#0b1020 55%);color:var(--fg);font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Inter,sans-serif;line-height:1.55}
 .wrap{max-width:720px;margin:0 auto;padding:64px 22px}h1{font-size:34px;margin:0 0 8px;letter-spacing:-.5px}p{color:var(--muted)}
 .btn{display:inline-flex;gap:8px;align-items:center;border:0;border-radius:10px;padding:13px 20px;font-size:15px;font-weight:700;cursor:pointer;background:linear-gradient(180deg,#7c9cff,#5f82ff);color:#08102a;margin-top:14px}
 pre{background:#0a1330;border:1px solid var(--line);border-radius:12px;padding:16px;overflow:auto;font-size:13px;color:#d7e2ff}
 .card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:20px;margin-top:18px}
 code{color:var(--accent)}.copy{cursor:pointer;border:0;background:#1a2752;color:var(--muted);border-radius:7px;padding:5px 9px;font-size:12px;margin-left:8px}
 a{color:var(--brand)}.hide{display:none}.note{font-size:12.5px;color:#6b7aa6;margin-top:10px}
</style></head><body><div class="wrap">
 <h1>Get your Countersign key</h1>
 <p>One click gives you an API key + a ready-to-paste MCP config — the cross-vendor kill switch and spend guard inside Claude, Cursor, or any MCP client. Testnet sandbox; no funds, no signup form.</p>
 <button class="btn" id="go">Generate my key →</button>
 <div id="out" class="hide">
  <div class="card"><b>Your API key</b> <button class="copy" data-t="key">Copy</button><pre id="key"></pre>
   <div class="note">Store it now — it isn't shown again.</div></div>
  <div class="card"><b>MCP config</b> (Claude / Cursor) <button class="copy" data-t="mcp">Copy</button><pre id="mcp"></pre>
   <div class="note">Or just run: <code>npx @countersign/mcp</code> with those env vars. Docs: <a href="https://github.com/countersign-network/countersign/tree/main/packages/mcp">@countersign/mcp</a></div></div>
 </div>
 <p id="err" class="hide" style="color:#ff8a8a"></p>
</div><script>
 const $=id=>document.getElementById(id);
 $("go").addEventListener("click",async()=>{
  $("go").disabled=true;$("go").textContent="Generating…";$("err").className="hide";
  try{
   const r=await fetch("/signup",{method:"POST"});
   if(!r.ok){throw new Error((await r.json()).error||("HTTP "+r.status));}
   const d=await r.json();
   $("key").textContent=d.apiKey;
   $("mcp").textContent=JSON.stringify(d.mcp,null,2);
   $("out").className="";$("go").className="hide";
  }catch(e){$("err").textContent="Couldn't generate a key: "+e.message;$("err").className="";$("go").disabled=false;$("go").textContent="Generate my key →";}
 });
 document.querySelectorAll(".copy").forEach(b=>b.addEventListener("click",()=>navigator.clipboard&&navigator.clipboard.writeText($(b.dataset.t).textContent)));
</script></body></html>`;

function send(res: ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json" });
  res.end(json);
}

/** Thrown for a malformed/oversized request body; mapped to 400 by the handler. */
class BadRequestError extends Error {}

const MAX_BODY_BYTES = 64 * 1024; // cap the body — don't buffer unbounded input into memory (DoS).

async function readJson<T>(req: IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new BadRequestError("request body too large");
    chunks.push(c as Buffer);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) return {} as T;
  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new BadRequestError("invalid JSON body");
  }
}

const toDto = (r: { index: number; prevHash: string; payloadHash: string; rowHash: string; payload: unknown }): LedgerRecordDTO =>
  ({ index: r.index, prevHash: r.prevHash, payloadHash: r.payloadHash, rowHash: r.rowHash, payload: r.payload as LedgerRecordDTO["payload"] });

export type Role = "viewer" | "operator" | "admin";
const ROLE_RANK: Record<Role, number> = { viewer: 1, operator: 2, admin: 3 };

export interface ApiKeyInfo {
  tenant: string;
  role: Role;
}

export interface CountersignServerOptions {
  /**
   * Map of API key -> { tenant, role }. If non-empty, every JSON route requires a valid key
   * (Authorization: Bearer <key>, or x-api-key). Empty => OPEN (demo mode). Roles: viewer (read),
   * operator (+ policy/freeze/approve/evaluate), admin. The tenant is the multi-tenancy seam (THREAT-MODEL.md).
   */
  apiKeys?: Record<string, ApiKeyInfo>;
  /**
   * Fixed-window rate limit, per API key (or per client IP when open). `max` bounds mutating routes,
   * `maxReads` bounds gated reads (incl. the full-ledger pull). max/maxReads <= 0 disables that bucket.
   */
  rateLimit?: { windowMs?: number; max?: number; maxReads?: number };
  /**
   * Trust `X-Forwarded-For` for the client IP (rate-limit key). OFF by default because XFF is
   * client-spoofable — turn it on ONLY when the Core sits behind a proxy that overwrites inbound XFF
   * (e.g. Render). When off, the socket peer address is authoritative and XFF is ignored.
   */
  trustProxy?: boolean;
  /**
   * Optional dynamic key store (DB-backed). Presented keys are resolved against `apiKeys` first, then
   * the store (so static admin keys + self-serve keys coexist). Enables the open `POST /signup` path.
   */
  keyStore?: KeyStore;
  /** Self-serve signup (mints a key for a fresh tenant). Off unless `enabled` and a keyStore is set. */
  signup?: { enabled?: boolean; maxPerWindow?: number };
  /** Public base URL of this Core, echoed into the signup response's MCP config (e.g. https://app.countersign.network). */
  publicUrl?: string;
}

function apiKeyFrom(req: IncomingMessage): string {
  const auth = req.headers["authorization"];
  if (typeof auth === "string" && auth.startsWith("Bearer ")) return auth.slice(7).trim();
  const x = req.headers["x-api-key"];
  return typeof x === "string" ? x : "";
}

// Mutating / spend-decision routes need operator+; everything else is read-only (viewer+).
const WRITE_ROUTES = new Set(["POST /policy", "POST /freeze", "POST /unfreeze", "POST /evaluate", "POST /approve", "POST /deny", "POST /connect"]);

export function createCountersignServer(coreOrResolver: CountersignCore | CoreResolver, opts: CountersignServerOptions = {}): CountersignServer {
  // A single Core => single-tenant (the demo). A resolver => one isolated Core per tenant.
  const resolveCore: CoreResolver = typeof coreOrResolver === "function" ? coreOrResolver : () => coreOrResolver;
  const apiKeys = opts.apiKeys ?? {};
  const keyStore = opts.keyStore;
  const authEnabled = Object.keys(apiKeys).length > 0 || keyStore !== undefined;
  const signupEnabled = (opts.signup?.enabled ?? false) && keyStore !== undefined;
  const signupMax = opts.signup?.maxPerWindow ?? 3;
  const publicUrl = opts.publicUrl;
  if (!authEnabled && process.env["NODE_ENV"] !== "test") {
    console.warn("[countersign] no API keys configured — the API is OPEN. Set COUNTERSIGN_API_KEYS to lock it down.");
  }

  // Fixed-window rate limiter — a basic DoS / runaway-agent guard. Separate buckets so a flood of
  // reads (e.g. the full-ledger pull) can't crowd out writes and vice-versa.
  const windowMs = opts.rateLimit?.windowMs ?? 60_000;
  const maxWrites = opts.rateLimit?.max ?? 120;
  const maxReads = opts.rateLimit?.maxReads ?? 600;
  const hits = new Map<string, { count: number; reset: number }>();
  const allow = (bucket: string, id: string, max: number): boolean => {
    if (max <= 0) return true;
    const key = `${bucket}:${id}`;
    const now = Date.now();
    const e = hits.get(key);
    if (!e || now >= e.reset) {
      hits.set(key, { count: 1, reset: now + windowMs });
      return true;
    }
    e.count += 1;
    return e.count <= max;
  };

  // Client IP for the rate-limit key. XFF is client-spoofable, so it's read ONLY behind a trusted
  // proxy (see opts.trustProxy); otherwise the socket peer is authoritative.
  const trustProxy = opts.trustProxy ?? false;
  const clientIp = (req: IncomingMessage): string => {
    if (trustProxy) {
      const xff = req.headers["x-forwarded-for"];
      const first = (Array.isArray(xff) ? xff[0] : xff)?.split(",")[0]?.trim();
      if (first) return first;
    }
    return req.socket.remoteAddress ?? "anon";
  };

  // Short-lived, single-use tickets for the ws handshake. A WebSocket can't carry an Authorization
  // header from a browser, and a long-lived key in the ws URL leaks into access logs / proxies /
  // history. So an authenticated client POSTs /ws-ticket (Bearer key) and connects with ?ticket=<t>.
  const WS_TICKET_TTL_MS = 30_000;
  const wsTickets = new Map<string, { tenant: string; expires: number }>();
  const issueWsTicket = (tenant: string): { ticket: string; expiresInMs: number } => {
    const now = Date.now();
    if (wsTickets.size > 1024) for (const [t, e] of wsTickets) if (now >= e.expires) wsTickets.delete(t);
    const ticket = randomBytes(32).toString("base64url");
    wsTickets.set(ticket, { tenant, expires: now + WS_TICKET_TTL_MS });
    return { ticket, expiresInMs: WS_TICKET_TTL_MS };
  };
  const redeemWsTicket = (ticket: string): string | undefined => {
    const e = wsTickets.get(ticket);
    if (!e) return undefined;
    wsTickets.delete(ticket); // single-use
    return Date.now() >= e.expires ? undefined : e.tenant;
  };

  // Open onboarding + liveness surface (no auth). Everything else is gated.
  const OPEN_ROUTES = new Set(["GET /", "GET /health", "GET /start"]);

  const http = createServer((req, res) => {
    void handleRequest(req, res).catch((err) => {
      if (err instanceof BadRequestError) {
        if (!res.headersSent) send(res, 400, { error: err.message });
        return;
      }
      // Log the detail server-side; never leak raw vendor/internal error strings to the caller.
      console.error("[countersign] request error:", err);
      if (!res.headersSent) send(res, 500, { error: "internal error" });
    });
  });

  async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://localhost");
    const route = `${req.method} ${url.pathname}`;

    // Self-serve onboarding (open): the get-key page + the rate-limited signup endpoint.
    if (route === "GET /start") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      return void res.end(START_HTML);
    }
    if (route === "POST /signup") return void (await handleSignup(req, res));

    const isOpen = OPEN_ROUTES.has(route);
    let tenantId = "default";
    if (authEnabled && !isOpen) {
      // Resolve the key: static admin map first, then the dynamic (DB) store. Both coexist.
      const key = apiKeyFrom(req);
      const info = apiKeys[key] ?? (key && keyStore ? await keyStore.lookup(key) : undefined);
      if (!info) {
        return void send(res, 401, { error: "unauthorized: provide a valid API key via 'Authorization: Bearer <key>'" });
      }
      const need: Role = WRITE_ROUTES.has(route) ? "operator" : "viewer";
      if (ROLE_RANK[info.role] < ROLE_RANK[need]) {
        return void send(res, 403, { error: `forbidden: '${need}' role required (this key is '${info.role}')` });
      }
      tenantId = info.tenant;
    }
    if (!isOpen) {
      // Rate-limit every gated route. Writes and reads have separate budgets keyed by API key
      // (or client IP in open mode) so neither can starve the other.
      const rlId = apiKeyFrom(req) || `${clientIp(req)}:${tenantId}`;
      const ok = WRITE_ROUTES.has(route) ? allow("w", rlId, maxWrites) : allow("r", rlId, maxReads);
      if (!ok) {
        res.setHeader("retry-after", String(Math.ceil(windowMs / 1000)));
        return void send(res, 429, { error: "rate limit exceeded — slow down" });
      }
    }
    res.setHeader("x-countersign-tenant", tenantId);
    const core = await resolveCore(tenantId);
    await handle(core, req, res, tenantId, issueWsTicket);
  }

  // Mint a key for a fresh isolated tenant. Open, but per-IP throttled AND globally capped (keyStore),
  // and every key is stored only as a hash. Testnet sandboxes — no funds, no PII collected.
  async function handleSignup(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!signupEnabled || !keyStore) return void send(res, 404, { error: "signup is not enabled" });
    if (!allow("signup", clientIp(req), signupMax)) {
      res.setHeader("retry-after", String(Math.ceil(windowMs / 1000)));
      return void send(res, 429, { error: "too many signups from this address — try again shortly" });
    }
    let issued: IssuedKey;
    try {
      issued = await keyStore.issue({ role: "operator", label: "self-serve" });
    } catch {
      return void send(res, 503, { error: "signup temporarily unavailable (capacity reached)" });
    }
    const proto = (req.headers["x-forwarded-proto"] as string | undefined) ?? "https";
    const u = publicUrl ?? `${proto}://${req.headers["host"] ?? "app.countersign.network"}`;
    return void send(res, 200, {
      apiKey: issued.apiKey,
      tenant: issued.tenant,
      url: u,
      mcp: {
        mcpServers: {
          countersign: {
            command: "npx",
            args: ["-y", "@countersign/mcp"],
            env: { COUNTERSIGN_URL: u, COUNTERSIGN_API_KEY: issued.apiKey },
          },
        },
      },
    });
  }

  const wss = new WebSocketServer({ server: http, path: WS_PATH });
  wss.on("connection", async (socket, req) => {
    let tenantId = "default";
    if (authEnabled) {
      // The stream authenticates with a single-use ?ticket=<t> from POST /ws-ticket — never the raw
      // API key (which would leak into ws-URL access logs). Tickets are short-lived and one-shot.
      const ticket = new URL(req.url ?? "/", "http://localhost").searchParams.get("ticket") ?? "";
      const tenant = redeemWsTicket(ticket);
      if (!tenant) {
        socket.close(1008, "unauthorized");
        return;
      }
      tenantId = tenant;
    }
    const core = await resolveCore(tenantId); // stream this tenant's ledger only
    const tx = (m: WsServerMessage) => socket.readyState === socket.OPEN && socket.send(JSON.stringify(m));
    tx({ type: "hello", providers: await core.health() });
    const unsub = core.onLedgerAppend((record) => tx({ type: "ledger_append", record: toDto(record) }));
    socket.on("close", unsub);
  });

  return {
    http,
    listen(port = 0): Promise<number> {
      return new Promise((resolve) => {
        http.listen(port, () => {
          const addr = http.address();
          resolve(typeof addr === "object" && addr ? addr.port : port);
        });
      });
    },
    close(): Promise<void> {
      return new Promise((resolve) => {
        wss.close(() => http.close(() => resolve()));
      });
    },
  };
}

async function handle(
  core: CountersignCore,
  req: IncomingMessage,
  res: ServerResponse,
  tenantId: string,
  issueWsTicket: (tenant: string) => { ticket: string; expiresInMs: number },
): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost");
  const route = `${req.method} ${url.pathname}`;

  switch (route) {
    case "POST /ws-ticket": {
      // Exchange a valid API key (any role — the stream is read-only) for a single-use ws ticket so
      // the key never travels in the ws URL. Gated as a read route by the auth/rate-limit layer.
      return send(res, 200, issueWsTicket(tenantId));
    }
    case "GET /": {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      return void res.end(DASHBOARD_HTML);
    }
    case "GET /health": {
      const providers = await core.health();
      const body: HealthResponse = { ok: providers.every((p) => p.healthy), providers };
      return send(res, 200, body);
    }
    case "GET /agents": {
      const body: AgentsResponse = {
        agents: core.agents().map((a) => ({
          providerId: a.provider,
          agentId: a.agentId,
          wallet: a.wallet,
          venue: a.venue,
          mode: core.modeOf(a.provider) as AgentsResponse["agents"][number]["mode"],
        })),
      };
      return send(res, 200, body);
    }
    case "POST /policy": {
      const reqBody = await readJson<ApplyPolicyRequest>(req);
      // Validate at the boundary — the client is untrusted. parsePolicy enforces the full schema
      // incl. the strict hex-address rule (closes the CEL-injection vector before it reaches compile).
      let policy;
      try {
        policy = parsePolicy(reqBody.policy);
      } catch (err) {
        return send(res, 400, { error: "invalid policy", detail: err instanceof Error ? err.message : String(err) });
      }
      const result = await core.applyPolicy(policy, reqBody.agentId ? asAgentId(reqBody.agentId) : undefined);
      return send(res, 200, result);
    }
    case "POST /freeze": {
      const reqBody = await readJson<FreezeRequest>(req);
      const report = await core.freezeAll(reqBody.reason ?? `freeze via API (tenant ${tenantId})`);
      return send(res, 200, report);
    }
    case "GET /backends": {
      // The connectable-backend catalog + moat metrics — drives the "connect a 2nd backend" demo.
      return send(res, 200, await backendsView(core));
    }
    case "POST /connect": {
      const b = await readJson<{ providerId?: string }>(req);
      if (!b.providerId) return send(res, 400, { error: "providerId required" });
      try {
        return send(res, 200, await connectBackend(core, b.providerId));
      } catch (err) {
        return send(res, 400, { error: err instanceof Error ? err.message : String(err) });
      }
    }
    case "GET /metrics": {
      return send(res, 200, await metricsOf(core));
    }
    case "POST /unfreeze": {
      await core.unfreezeAll();
      return send(res, 200, { ok: true });
    }
    case "POST /evaluate": {
      const b = await readJson<EvaluateRequest>(req);
      // Validate before any BigInt(amount) / policy eval — a bad amount must be a 400, not a 500.
      if (
        typeof b.agentId !== "string" || !b.agentId ||
        typeof b.asset !== "string" || !b.asset ||
        typeof b.venue !== "string" || !b.venue ||
        typeof b.amount !== "string" || !/^\d+$/.test(b.amount) ||
        (b.counterparty !== undefined && typeof b.counterparty !== "string")
      ) {
        return send(res, 400, { error: "invalid evaluate request: need non-empty agentId/asset/venue and an integer base-unit amount" });
      }
      const decision = await core.evaluateSpend(asAgentId(b.agentId), {
        amount: b.amount,
        asset: b.asset,
        venue: b.venue,
        ...(b.counterparty !== undefined ? { counterparty: b.counterparty } : {}),
      });
      return send(res, 200, decision);
    }
    case "GET /approvals": {
      return send(res, 200, core.approvals());
    }
    case "POST /approve": {
      const b = await readJson<ApproveRequest>(req);
      return send(res, 200, await core.approve(b.approvalToken));
    }
    case "POST /deny": {
      const b = await readJson<DenyRequest>(req);
      return send(res, 200, await core.deny(b.approvalToken, b.reason));
    }
    case "GET /ledger": {
      const records = (await core.ledgerRecords()).map(toDto);
      const publicKey = core.ledgerPublicKey();
      const body: LedgerResponse = { records, verified: await core.verifyLedger(), ...(publicKey ? { publicKey } : {}) };
      return send(res, 200, body);
    }
    default:
      return send(res, 404, { error: `no route: ${route}` });
  }
}
