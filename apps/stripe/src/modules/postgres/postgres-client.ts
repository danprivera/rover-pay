import { Pool, type PoolConfig } from "pg";

import { env } from "@/lib/env";

/**
 * Rover Pay's Postgres storage (rovershop-storefront#173).
 *
 * Upstream keeps configs, recorded transactions and the APL in DynamoDB; Rover
 * Pay runs on Azure, so they live in their own database on the existing
 * Postgres server instead. Every table is scoped by (saleor_api_url, app_id)
 * exactly as the DynamoDB partition keys are, so one database serves any
 * number of installations without them seeing each other's rows.
 */

/** Anything that can run a parameterised query - a Pool, or a test double (pg-mem). */
export type Queryable = Pick<Pool, "query">;

let pool: Pool | null = null;
let schemaReady: Promise<void> | null = null;

export function createPostgresPool(config: PoolConfig = {}): Pool {
  const connectionString = env.DATABASE_URL;

  if (!connectionString) {
    throw new Error("DATABASE_URL is required when STORAGE or APL is postgres");
  }

  return new Pool({ connectionString, max: 10, idleTimeoutMillis: 30_000, ...config });
}

/** The process-wide pool, created on first use - importing this module connects to nothing. */
export function getPostgresPool(): Pool {
  pool ??= createPostgresPool();

  return pool;
}

/**
 * Creates the tables if they are missing. Idempotent, run once per process
 * before the first query - there are no migrations to track at this size, and
 * `IF NOT EXISTS` makes every boot safe.
 */
export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS rp_apl (
  saleor_api_url TEXT PRIMARY KEY,
  app_id TEXT NOT NULL,
  token_enc TEXT NOT NULL,
  jwks TEXT
);

CREATE TABLE IF NOT EXISTS rp_stripe_config (
  saleor_api_url TEXT NOT NULL,
  app_id TEXT NOT NULL,
  config_id TEXT NOT NULL,
  config_name TEXT NOT NULL,
  publishable_key TEXT NOT NULL,
  restricted_key_enc TEXT NOT NULL,
  webhook_id TEXT NOT NULL,
  webhook_secret_enc TEXT NOT NULL,
  PRIMARY KEY (saleor_api_url, app_id, config_id)
);

CREATE TABLE IF NOT EXISTS rp_channel_config_mapping (
  saleor_api_url TEXT NOT NULL,
  app_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  config_id TEXT,
  PRIMARY KEY (saleor_api_url, app_id, channel_id)
);

CREATE TABLE IF NOT EXISTS rp_recorded_transaction (
  saleor_api_url TEXT NOT NULL,
  app_id TEXT NOT NULL,
  payment_intent_id TEXT NOT NULL,
  saleor_transaction_id TEXT NOT NULL,
  saleor_transaction_flow TEXT NOT NULL,
  resolved_transaction_flow TEXT NOT NULL,
  selected_payment_method TEXT NOT NULL,
  saleor_schema_major INTEGER NOT NULL,
  saleor_schema_minor INTEGER NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (saleor_api_url, app_id, payment_intent_id)
);
`;

export async function ensureSchema(db: Queryable): Promise<void> {
  await db.query(SCHEMA_SQL);
}

/** The pool, with the schema guaranteed - what every repository awaits before its query. */
export async function readyPool(): Promise<Queryable> {
  const db = getPostgresPool();

  schemaReady ??= ensureSchema(db).catch((error: unknown) => {
    // Let the next call try again rather than caching a failure forever.
    schemaReady = null;
    throw error;
  });
  await schemaReady;

  return db;
}
