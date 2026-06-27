/**
 * The Core HTTP + websocket server — the only thing the (key-less) client talks to. REST mirrors
 * openapi.yaml; the ws stream pushes WsServerMessage. Implemented on node:http + ws to keep the
 * dependency surface tiny for the proof.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
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

export interface CountersignServer {
  http: Server;
  listen(port?: number): Promise<number>;
  close(): Promise<void>;
}

// The first-demo web dashboard (handoff: "a plain web dashboard is fine for the very first demo").
const DASHBOARD_HTML = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "dashboard.html"), "utf8");

function send(res: ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json" });
  res.end(json);
}

async function readJson<T>(req: IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? (JSON.parse(raw) as T) : ({} as T);
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
  /** Fixed-window rate limit on mutating routes, per API key (or per client IP when open). max<=0 disables. */
  rateLimit?: { windowMs?: number; max?: number };
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
  const authEnabled = Object.keys(apiKeys).length > 0;
  if (!authEnabled && process.env["NODE_ENV"] !== "test") {
    console.warn("[countersign] no API keys configured — the API is OPEN. Set COUNTERSIGN_API_KEYS to lock it down.");
  }

  // Fixed-window rate limiter for mutating routes — a basic DoS / runaway-agent guard.
  const windowMs = opts.rateLimit?.windowMs ?? 60_000;
  const maxWrites = opts.rateLimit?.max ?? 120;
  const hits = new Map<string, { count: number; reset: number }>();
  const allowWrite = (key: string): boolean => {
    if (maxWrites <= 0) return true;
    const now = Date.now();
    const e = hits.get(key);
    if (!e || now >= e.reset) {
      hits.set(key, { count: 1, reset: now + windowMs });
      return true;
    }
    e.count += 1;
    return e.count <= maxWrites;
  };

  const http = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const route = `${req.method} ${url.pathname}`;
    // GET / (dashboard) and GET /health stay open: liveness probes + the demo UI. Everything else gated.
    const isOpen = req.method === "GET" && (url.pathname === "/" || url.pathname === "/health");
    let tenantId = "default";
    if (authEnabled && !isOpen) {
      const info = apiKeys[apiKeyFrom(req)];
      if (!info) {
        return send(res, 401, { error: "unauthorized: provide a valid API key via 'Authorization: Bearer <key>'" });
      }
      const need: Role = WRITE_ROUTES.has(route) ? "operator" : "viewer";
      if (ROLE_RANK[info.role] < ROLE_RANK[need]) {
        return send(res, 403, { error: `forbidden: '${need}' role required (this key is '${info.role}')` });
      }
      tenantId = info.tenant;
    }
    if (WRITE_ROUTES.has(route)) {
      const rlKey = apiKeyFrom(req) || `${req.socket.remoteAddress ?? "anon"}:${tenantId}`;
      if (!allowWrite(rlKey)) {
        res.setHeader("retry-after", String(Math.ceil(windowMs / 1000)));
        return send(res, 429, { error: "rate limit exceeded — slow down" });
      }
    }
    res.setHeader("x-countersign-tenant", tenantId);
    Promise.resolve(resolveCore(tenantId))
      .then((core) => handle(core, req, res, tenantId))
      .catch((err) => {
        send(res, 500, { error: err instanceof Error ? err.message : String(err) });
    });
  });

  const wss = new WebSocketServer({ server: http, path: WS_PATH });
  wss.on("connection", async (socket, req) => {
    let tenantId = "default";
    if (authEnabled) {
      // Browsers can't set ws headers, so the event stream takes the key as ?key=<key> when auth is on.
      const info = apiKeys[new URL(req.url ?? "/", "http://localhost").searchParams.get("key") ?? ""];
      if (!info) {
        socket.close(1008, "unauthorized");
        return;
      }
      tenantId = info.tenant;
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

async function handle(core: CountersignCore, req: IncomingMessage, res: ServerResponse, tenantId: string): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost");
  const route = `${req.method} ${url.pathname}`;

  switch (route) {
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
