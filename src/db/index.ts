/**
 * Database driver dispatcher.
 *
 * Reads `DB_DRIVER` env var (`sqlite` | `postgres`) and routes init/get/close
 * to the correct backend.
 *
 * SQLite is the default and fully supported across all consumers.
 *
 * Postgres is partially supported: the Drizzle ORM layer (migrations, schema)
 * works end-to-end, but raw-SQL consumers (runs.ts, model-resolver.ts,
 * session/store.ts, auth/rbac.ts, providers/custom.ts, catalog/*, several
 * dashboard routes, etc.) use `better-sqlite3` and need migration to
 * Drizzle ORM queries via `getDrizzleDb()` for full Postgres compat.
 */

import { initDb as initSqlite, getDb as getSqlite, getDrizzleClient as getSqliteDrizzle, closeDb as closeSqlite } from './client.js';
import { initPostgres, getPgClient, closePostgres } from './postgres.js';
import { dbPath } from '../paths.js';
import type { Database as SqliteDb } from 'better-sqlite3';
import type { PgClient } from './postgres.js';

export type DbClient = SqliteDb;
export type DrizzleClient = ReturnType<typeof getSqliteDrizzle> | PgClient;

let _driver: 'sqlite' | 'postgres' = 'sqlite';

export function initDb(dbPathOverride?: string): DbClient {
  const driver = (process.env.DB_DRIVER ?? 'sqlite').toLowerCase();
  if (driver === 'postgres') {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error('DATABASE_URL is required when DB_DRIVER=postgres');
    initPostgres(url);
    _driver = 'postgres';
    // Return a proxy that provides clear errors for raw-SQL consumers
    return new Proxy({} as SqliteDb, {
      get(_, prop) {
        throw new Error(
          `Postgres driver active, but '${String(prop)}' accessed — this raw-SQL consumer needs Drizzle ORM migration.`
        );
      },
    });
  }
  _driver = 'sqlite';
  return initSqlite(dbPathOverride ?? dbPath());
}

export function getDb(): DbClient {
  if (_driver === 'postgres') {
    throw new Error(
      'Postgres driver active — raw-SQL consumer called getDb().\n' +
      'This module needs migration to Drizzle ORM. Use the providers/sessions/schema tables via Drizzle.'
    );
  }
  return getSqlite();
}

/**
 * Return the canonical Drizzle ORM client, regardless of which driver is active.
 * Use this for all new Drizzle ORM code; it works with both SQLite and Postgres.
 *
 * Returns a loosely-typed client because SQLite and Postgres Drizzle clients
 * have incompatible TypeScript generics (union of two disjoint signatures),
 * but the same runtime API. Consumers should cast to `any` or use the typed
 * query helpers in `db/query.ts`.
 */
export function getDrizzleDb(): any {
  if (_driver === 'postgres') {
    return getPgClient();
  }
  return getSqliteDrizzle();
}

export function getDriver(): 'sqlite' | 'postgres' {
  return _driver;
}

export async function closeDb(): Promise<void> {
  if (_driver === 'postgres') {
    await closePostgres();
  } else {
    closeSqlite();
  }
}
