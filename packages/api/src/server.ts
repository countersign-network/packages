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
import { asAgentId } from "@cosign/core";
import {
  WS_PATH,
  type AgentsResponse,
  type ApplyPolicyRequest,
  type EvaluateRequest,
  type FreezeRequest,
  type HealthResponse,
  type LedgerRecordDTO,
  type LedgerResponse,
  type WsServerMessage,
} from "@cosign/api-contract";
import { CosignCore } from "./core-service";

export interface CosignServer {
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

export function createCosignServer(core: CosignCore): CosignServer {
  const http = createServer((req, res) => {
    handle(core, req, res).catch((err) => {
      send(res, 500, { error: err instanceof Error ? err.message : String(err) });
    });
  });

  const wss = new WebSocketServer({ server: http, path: WS_PATH });
  wss.on("connection", async (socket) => {
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

async function handle(core: CosignCore, req: IncomingMessage, res: ServerResponse): Promise<void> {
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
      const result = await core.applyPolicy(reqBody.policy, reqBody.agentId ? asAgentId(reqBody.agentId) : undefined);
      return send(res, 200, result);
    }
    case "POST /freeze": {
      const reqBody = await readJson<FreezeRequest>(req);
      const report = await core.freezeAll(reqBody.reason ?? "freeze via dashboard");
      return send(res, 200, report);
    }
    case "POST /unfreeze": {
      await core.unfreezeAll();
      return send(res, 200, { ok: true });
    }
    case "POST /evaluate": {
      const b = await readJson<EvaluateRequest>(req);
      const decision = await core.evaluateSpend(asAgentId(b.agentId), {
        amount: b.amount,
        asset: b.asset,
        venue: b.venue,
        ...(b.counterparty !== undefined ? { counterparty: b.counterparty } : {}),
      });
      return send(res, 200, decision);
    }
    case "GET /ledger": {
      const records = (await core.ledgerRecords()).map(toDto);
      const body: LedgerResponse = { records, verified: await core.verifyLedger() };
      return send(res, 200, body);
    }
    default:
      return send(res, 404, { error: `no route: ${route}` });
  }
}
