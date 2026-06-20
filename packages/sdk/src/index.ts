/**
 * @cosign/sdk — the front door (roadmap Tier 0 #4). A tiny typed client over the Core API so an
 * agent operator wires Cosign in trivially. Works in Node (22+) and the browser — uses only global
 * fetch + WebSocket, no dependencies beyond the shared contract. The Flutter/Dart client is
 * generated from the same api-contract; this is its TypeScript twin.
 *
 *   const cosign = new CosignClient({ baseUrl: "http://localhost:8080" });
 *   await cosign.applyPolicy({ policy });           // compile + apply across every backend
 *   const stop = cosign.subscribe((m) => ...);       // live ledger stream
 *   await cosign.freeze({ reason: "kill switch" });   // one call, every vendor, < 1s
 */

import {
  WS_PATH,
  type AgentsResponse,
  type ApplyPolicyRequest,
  type ApplyPolicyResult,
  type FreezeRequest,
  type FreezeResponse,
  type HealthResponse,
  type LedgerResponse,
  type WsServerMessage,
} from "@cosign/api-contract";

// Re-export the wire contract so SDK users import everything from one place.
export type {
  AgentDTO,
  AgentsResponse,
  ApplyPolicyRequest,
  ApplyPolicyResult,
  FreezeRequest,
  FreezeResponse,
  HealthResponse,
  LedgerRecordDTO,
  LedgerResponse,
  ProviderHealth,
  WsServerMessage,
} from "@cosign/api-contract";

export class CosignApiError extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
  ) {
    super(`Cosign API ${status}: ${body}`);
    this.name = "CosignApiError";
  }
}

export interface CosignClientOptions {
  baseUrl: string;
  /** Override fetch (tests / non-global environments). Defaults to the global fetch. */
  fetch?: typeof fetch;
}

export class CosignClient {
  private readonly baseUrl: string;
  private readonly doFetch: typeof fetch;

  constructor(opts: CosignClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/$/, "");
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
    const url = this.baseUrl.replace(/^http/, "ws") + WS_PATH;
    const ws = new WebSocket(url);
    ws.addEventListener("message", (ev) => {
      try {
        onMessage(JSON.parse(String((ev as MessageEvent).data)) as WsServerMessage);
      } catch {
        /* ignore malformed frames */
      }
    });
    return () => ws.close();
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const init: RequestInit = { method };
    if (body !== undefined) {
      init.headers = { "content-type": "application/json" };
      init.body = JSON.stringify(body);
    }
    const res = await this.doFetch(this.baseUrl + path, init);
    if (!res.ok) throw new CosignApiError(res.status, await res.text());
    return (await res.json()) as T;
  }
}
