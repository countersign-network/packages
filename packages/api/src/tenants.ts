import type { CosignCore } from "./core-service";

/**
 * Multi-tenancy by Core-instance: each tenant gets its OWN CosignCore — fully isolated providers,
 * agents, policies, and ledger. The server resolves the tenant from the API key (the auth seam) and
 * routes the request to that tenant's Core. A function lets you back it by anything (a static map,
 * a DB-driven factory, etc.).
 */
export type CoreResolver = (tenantId: string) => CosignCore | Promise<CosignCore>;

/** Lazily creates and caches one CosignCore per tenant via a factory. Concurrent-safe. */
export class TenantRegistry {
  private readonly cores = new Map<string, CosignCore>();
  private readonly pending = new Map<string, Promise<CosignCore>>();

  constructor(private readonly factory: (tenantId: string) => CosignCore | Promise<CosignCore>) {}

  coreFor(tenantId: string): Promise<CosignCore> {
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

  /** Use as the `createCosignServer` resolver. */
  resolver(): CoreResolver {
    return (tenantId) => this.coreFor(tenantId);
  }

  tenants(): string[] {
    return [...this.cores.keys()];
  }
}
