import type { CountersignCore } from "./core-service";

/**
 * Multi-tenancy by Core-instance: each tenant gets its OWN CountersignCore — fully isolated providers,
 * agents, policies, and ledger. The server resolves the tenant from the API key (the auth seam) and
 * routes the request to that tenant's Core. A function lets you back it by anything (a static map,
 * a DB-driven factory, etc.).
 */
export type CoreResolver = (tenantId: string) => CountersignCore | Promise<CountersignCore>;

/** Lazily creates and caches one CountersignCore per tenant via a factory. Concurrent-safe. */
export class TenantRegistry {
  private readonly cores = new Map<string, CountersignCore>();
  private readonly pending = new Map<string, Promise<CountersignCore>>();

  constructor(private readonly factory: (tenantId: string) => CountersignCore | Promise<CountersignCore>) {}

  coreFor(tenantId: string): Promise<CountersignCore> {
    const existing = this.cores.get(tenantId);
    if (existing) return Promise.resolve(existing);
    let p = this.pending.get(tenantId);
    if (!p) {
      p = Promise.resolve(this.factory(tenantId)).then((core) => {
        this.cores.set(tenantId, core);
        this.pending.delete(tenantId);
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
