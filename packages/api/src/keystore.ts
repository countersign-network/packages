/**
 * API-key store for self-serve onboarding. Keys are minted server-side and stored ONLY as a SHA-256
 * hash (never plaintext) → a DB dump can't be replayed against the API. Each key maps to an isolated
 * tenant (see TenantRegistry). A global cap bounds resource growth from the open /signup endpoint.
 */

import { createHash, randomBytes } from "node:crypto";
import type { Pool } from "pg";
import type { Role } from "./server";

export interface KeyInfo {
  tenant: string;
  role: Role;
}
export interface IssuedKey extends KeyInfo {
  apiKey: string;
}

export interface KeyStore {
  /** Resolve a presented plaintext key to its tenant+role, or undefined if unknown. */
  lookup(key: string): Promise<KeyInfo | undefined>;
  /** Mint a key for a FRESH tenant. Returns the plaintext once (only the hash is stored). */
  issue(opts?: { role?: Role; label?: string }): Promise<IssuedKey>;
}

const hashKey = (k: string): string => createHash("sha256").update(k, "utf8").digest("hex");
const mintKey = (): string => "csk_" + randomBytes(24).toString("base64url");
const mintTenant = (): string => "t_" + randomBytes(8).toString("hex");

/** In-memory store — tests + local/dev. Keys are lost on restart. */
export class InMemoryKeyStore implements KeyStore {
  private readonly byHash = new Map<string, KeyInfo>();
  constructor(private readonly cap = 1000) {}
  async lookup(key: string): Promise<KeyInfo | undefined> {
    return this.byHash.get(hashKey(key));
  }
  async issue(opts?: { role?: Role; label?: string }): Promise<IssuedKey> {
    if (this.byHash.size >= this.cap) throw new Error("signup cap reached");
    const apiKey = mintKey();
    const info: KeyInfo = { tenant: mintTenant(), role: opts?.role ?? "operator" };
    this.byHash.set(hashKey(apiKey), info);
    return { apiKey, ...info };
  }
}

/** Durable store over Postgres (Render managed PG via DATABASE_URL). */
export class PostgresKeyStore implements KeyStore {
  private constructor(
    private readonly pool: Pool,
    private readonly cap: number,
  ) {}

  static async create(connectionString: string, cap = 500): Promise<PostgresKeyStore> {
    const { Pool } = await import("pg");
    const ssl = /sslmode=require/.test(connectionString) ? { rejectUnauthorized: false } : false;
    const pool = new Pool({ connectionString, ssl });
    await pool.query(`
      CREATE TABLE IF NOT EXISTS api_keys (
        key_hash    TEXT PRIMARY KEY,
        tenant      TEXT NOT NULL,
        role        TEXT NOT NULL,
        label       TEXT,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `);
    return new PostgresKeyStore(pool, cap);
  }

  async lookup(key: string): Promise<KeyInfo | undefined> {
    const res = await this.pool.query<{ tenant: string; role: string }>(
      "SELECT tenant, role FROM api_keys WHERE key_hash = $1",
      [hashKey(key)],
    );
    const row = res.rows[0];
    return row ? { tenant: row.tenant, role: row.role as Role } : undefined;
  }

  async issue(opts?: { role?: Role; label?: string }): Promise<IssuedKey> {
    const { rows } = await this.pool.query<{ n: number }>("SELECT count(*)::int AS n FROM api_keys");
    if ((rows[0]?.n ?? 0) >= this.cap) throw new Error("signup cap reached");
    const apiKey = mintKey();
    const info: KeyInfo = { tenant: mintTenant(), role: opts?.role ?? "operator" };
    await this.pool.query("INSERT INTO api_keys (key_hash, tenant, role, label) VALUES ($1, $2, $3, $4)", [
      hashKey(apiKey),
      info.tenant,
      info.role,
      opts?.label ?? null,
    ]);
    return { apiKey, ...info };
  }
}
