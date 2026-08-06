/**
 * Database driver dispatcher.
 *
 * Reads `DB_DRIVER` env var (`sqlite` | `postgres`) and routes init/get/close
 * to the correct backend. SQLite is the default; Postgres is fully supported
 * by the Drizzle ORM layer (migrations, schema, db/query/* helpers).
 *
 * `getDb()` (raw better-sqlite3 client) is reserved for SQLite-only code and
 * throws under Postgres on purpose; all Postgres-capable code must use
 * `getDrizzleDb()` + `db/query/*` helpers, which are dialect-neutral.
 */

import { sql } from 'drizzle-orm';
import { initDb as initSqlite, getDb as getSqlite, getDrizzleClient as getSqliteDrizzle, closeDb as closeSqlite } from './client.js';
import { initPostgres, getPgClient, closePostgres } from './postgres.js';
import { dbPath } from '../paths.js';
import type { Database as SqliteDb } from 'better-sqlite3';

type DbClient = SqliteDb;

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
 * query helpers in `db/query.ts` (single barrel).
 */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- dialect-union escape hatch: SQLite and PG drizzle clients have incompatible TS generics; consumers cast results to concrete row types.
export function getDrizzleDb(): any {
  if (_driver === 'postgres') {
    return getPgClient();
  }
  return getSqliteDrizzle();
}

export function getDriver(): 'sqlite' | 'postgres' {
  return _driver;
}

/** Driver-aware health check: true when the active database answers SELECT 1. */
export async function pingDb(): Promise<boolean> {
  try {
    if (_driver === 'postgres') {
      await getPgClient().execute(sql`SELECT 1`);
    } else {
      await getSqliteDrizzle().run(sql`SELECT 1`);
    }
    return true;
  } catch {
    return false;
  }
}

export async function closeDb(): Promise<void> {
  if (_driver === 'postgres') {
    await closePostgres();
  } else {
    closeSqlite();
  }
}
