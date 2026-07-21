/**
 * Database driver dispatcher.
 *
 * Reads `DB_DRIVER` env var (`sqlite` | `postgres`) and routes init/get/close
 * to the correct backend.  SQLite is the default and the only fully-supported
 * driver for all consumers today — raw `better-sqlite3` calls in runs.ts,
 * model-resolver.ts, etc. are inherently synchronous and need a Drizzle-ORM
 * migration before Postgres works end-to-end.
 */

import { initDb as initSqlite, getDb as getSqlite, closeDb as closeSqlite } from './client.js';
import { initPostgres, closePostgres } from './postgres.js';
import type { Database as SqliteDb } from 'better-sqlite3';

export type DbClient = SqliteDb;

export function initDb(dbPath?: string): DbClient {
  const driver = (process.env.DB_DRIVER ?? 'sqlite').toLowerCase();
  if (driver === 'postgres') {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error('DATABASE_URL is required when DB_DRIVER=postgres');
    initPostgres(url);
    throw new Error(
      'Postgres driver selected but raw-SQL consumers (runs.ts, model-resolver.ts, etc.) ' +
      'have not been migrated to Drizzle ORM yet. Use DB_DRIVER=sqlite until migration is complete.'
    );
  }
  return initSqlite(dbPath!);
}

export function getDb(): DbClient {
  const driver = (process.env.DB_DRIVER ?? 'sqlite').toLowerCase();
  if (driver === 'postgres') {
    throw new Error(
      'Postgres driver selected but getDb() is used by raw-SQL consumers. ' +
      'Use getPgClient() from postgres.ts for Drizzle ORM queries instead.'
    );
  }
  return getSqlite();
}

export function closeDb(): Promise<void> | void {
  const driver = (process.env.DB_DRIVER ?? 'sqlite').toLowerCase();
  if (driver === 'postgres') {
    return closePostgres();
  }
  closeSqlite();
}
