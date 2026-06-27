/**
 * @countersign/sdk — the front door (roadmap Tier 0 #4). A tiny typed client over the Core API so an
 * agent operator wires Countersign in trivially. Works in Node (22+) and the browser — uses only global
 * fetch + WebSocket, no dependencies beyond the shared contract. The Flutter/Dart client is
 * generated from the same api-contract; this is its TypeScript twin.
 *
 *   const countersign = new CountersignClient({ baseUrl: "http://localhost:8080" });
 *   await countersign.applyPolicy({ policy });           // compile + apply across every backend
 *   const stop = countersign.subscribe((m) => ...);       // live ledger stream
 *   await countersign.freeze({ reason: "kill switch" });   // one call, every vendor, < 1s
 */

import {
  WS_PATH,
  type AgentsResponse,
  type ApplyPolicyRequest,
  type ApplyPolicyResult,
  type ApprovalResolution,
  type ApprovalsResponse,
  type ApproveRequest,
  type CountersignApi,
  type DenyRequest,
  type EvaluateRequest,
  type EvaluateResponse,
  type FreezeRequest,
  type FreezeResponse,
  type HealthResponse,
  type LedgerResponse,
  type WsServerMessage,
} from "@countersign/api-contract";

// Re-export the wire contract so SDK users import everything from one place.
export type {
  AgentDTO,
  AgentsResponse,
  ApplyPolicyRequest,
  ApplyPolicyResult,
  ApprovalResolution,
  ApprovalsResponse,
  ApproveRequest,
  CountersignApi,
  DenyRequest,
  EvaluateRequest,
  EvaluateResponse,
  FreezeRequest,
  FreezeResponse,
  HealthResponse,
  LedgerRecordDTO,
  LedgerResponse,
  PendingApprovalDTO,
  ProviderHealth,
  WsServerMessage,
} from "@countersign/api-contract";

export class CountersignApiError extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
  ) {
    super(`Countersign API ${status}: ${body}`);
    this.name = "CountersignApiError";
  }
}

export interface CountersignClientOptions {
  baseUrl: string;
  /** API key. Sent as `Authorization: Bearer <key>` on REST; exchanged for a ws ticket on subscribe. */
  apiKey?: string;
  /** Override fetch (tests / non-global environments). Defaults to the global fetch. */
  fetch?: typeof fetch;
}

export class CountersignClient implements CountersignApi {
  private readonly baseUrl: string;
  private readonly apiKey: string | undefined;
  private readonly doFetch: typeof fetch;

  constructor(opts: CountersignClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/$/, "");
    this.apiKey = opts.apiKey;
    this.doFetch = opts.fetch ?? fetch;
  }

  /** Liveness + per-backend health. */
  health(): Promise<HealthResponse> {
    return this.request<HealthResponse>("GET", "/health");
  }

  /** Every provisioned agent across all backends. */
  agents(): Promise<AgentsResponse> {
    return this.request<AgentsResponse>("GET", "/agents");
  }

  /** Compile + apply one unified policy across backends (fail-closed). */
  applyPolicy(req: ApplyPolicyRequest): Promise<ApplyPolicyResult> {
    return this.request<ApplyPolicyResult>("POST", "/policy", req);
  }

  /** The kill switch — freeze every agent on every backend. */
  freeze(req: FreezeRequest = {}): Promise<FreezeResponse> {
    return this.request<FreezeResponse>("POST", "/freeze", req);
  }

  /** Pre-flight guard: ask Countersign whether a spend is allowed BEFORE touching the wallet. */
  evaluate(req: EvaluateRequest): Promise<EvaluateResponse> {
    return this.request<EvaluateResponse>("POST", "/evaluate", req);
  }

  /** Spends currently held pending human approval. */
  approvals(): Promise<ApprovalsResponse> {
    return this.request<ApprovalsResponse>("GET", "/approvals");
  }

  /** Approve a pending spend (rejected if the system is frozen — fail-closed). */
  approve(req: ApproveRequest): Promise<ApprovalResolution> {
    return this.request<ApprovalResolution>("POST", "/approve", req);
  }

  /** Deny a pending spend. */
  deny(req: DenyRequest): Promise<ApprovalResolution> {
    return this.request<ApprovalResolution>("POST", "/deny", req);
  }

  /** Lift a freeze (replay / recover). */
  unfreeze(): Promise<{ ok: boolean }> {
    return this.request<{ ok: boolean }>("POST", "/unfreeze", {});
  }

  /** The append-only, hash-chained ledger, re-verified at read time. */
  ledger(): Promise<LedgerResponse> {
    return this.request<LedgerResponse>("GET", "/ledger");
  }

  /**
   * Subscribe to the live event stream (ledger appends, freeze reports). Returns an unsubscribe
   * function. Uses the global WebSocket — available in browsers and Node 22+.
   */
  subscribe(onMessage: (message: WsServerMessage) => void): () => void {
    let ws: WebSocket | undefined;
    let closed = false;
    const open = (query: string): void => {
      if (closed) return;
      ws = new WebSocket(this.baseUrl.replace(/^http/, "ws") + WS_PATH + query);
      ws.addEventListener("message", (ev) => {
        try {
          onMessage(JSON.parse(String((ev as MessageEvent).data)) as WsServerMessage);
        } catch {
          /* ignore malformed frames */
        }
      });
    };
    if (this.apiKey) {
      // Authenticated stream: exchange the key for a single-use ws ticket so it stays out of the URL.
      this.request<{ ticket: string }>("POST", "/ws-ticket", {})
        .then((r) => open(`?ticket=${encodeURIComponent(r.ticket)}`))
        .catch(() => {
          /* unauthorized / offline — leave unsubscribed; the caller can retry */
        });
    } else {
      open("");
    }
    return () => {
      closed = true;
      ws?.close();
    };
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const init: RequestInit = { method };
    const headers: Record<string, string> = {};
    if (this.apiKey) headers["authorization"] = `Bearer ${this.apiKey}`;
    if (body !== undefined) {
      headers["content-type"] = "application/json";
      init.body = JSON.stringify(body);
    }
    if (Object.keys(headers).length > 0) init.headers = headers;
    const res = await this.doFetch(this.baseUrl + path, init);
    if (!res.ok) throw new CountersignApiError(res.status, await res.text());
    return (await res.json()) as T;
  }
}
