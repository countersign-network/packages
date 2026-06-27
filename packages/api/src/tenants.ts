import type { CountersignCore } from "./core-service";

/**
 * Multi-tenancy by Core-instance: each tenant gets its OWN CountersignCore — fully isolated providers,
 * agents, policies, and ledger. The server resolves the tenant from the API key (the auth seam) and
 * routes the request to that tenant's Core. A function lets you back it by anything (a static map,
 * a DB-driven factory, etc.).
 */
export type CoreResolver = (tenantId: string) => CountersignCore | Promise<CountersignCore>;

export interface TenantRegistryOptions {
  /**
   * Max number of live tenant Cores held in memory. When exceeded, the least-recently-used Core is
   * evicted (its in-memory sandbox is dropped; the tenant's persisted key survives, so the next
   * request rebuilds a fresh Core). Bounds memory/DoS from open self-serve signup. Default: unbounded.
   */
  maxLive?: number;
}

/** Lazily creates and caches one CountersignCore per tenant via a factory. Concurrent-safe, LRU-capped. */
export class TenantRegistry {
  // Map insertion order is the LRU order (oldest first); a cache hit re-inserts to mark it most-recent.
  private readonly cores = new Map<string, CountersignCore>();
  private readonly pending = new Map<string, Promise<CountersignCore>>();
  private readonly maxLive: number;

  constructor(
    private readonly factory: (tenantId: string) => CountersignCore | Promise<CountersignCore>,
    opts: TenantRegistryOptions = {},
  ) {
    this.maxLive = opts.maxLive && opts.maxLive > 0 ? opts.maxLive : Infinity;
  }

  coreFor(tenantId: string): Promise<CountersignCore> {
    const existing = this.cores.get(tenantId);
    if (existing) {
      this.cores.delete(tenantId); // refresh recency: move to most-recent
      this.cores.set(tenantId, existing);
      return Promise.resolve(existing);
    }
    let p = this.pending.get(tenantId);
    if (!p) {
      p = Promise.resolve(this.factory(tenantId)).then((core) => {
        this.pending.delete(tenantId);
        // Evict least-recently-used Cores until there's room (bounds resource growth).
        while (this.cores.size >= this.maxLive) {
          const oldest = this.cores.keys().next().value;
          if (oldest === undefined) break;
          this.cores.delete(oldest);
        }
        this.cores.set(tenantId, core);
        return core;
      });
      this.pending.set(tenantId, p);
    }
    return p;
  }

  /** Use as the `createCountersignServer` resolver. */
  resolver(): CoreResolver {
    return (tenantId) => this.coreFor(tenantId);
  }

  tenants(): string[] {
    return [...this.cores.keys()];
  }
}
