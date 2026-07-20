import path from 'node:path';
import Database from 'better-sqlite3';
import type { Database as DatabaseType } from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import * as schema from './schema.js';

let dbInstance: DatabaseType | null = null;

function migrationsFolder(): string {
  return path.resolve(import.meta.dirname, '..', '..', 'drizzle');
}

/**
 * Initialise (or return) the shared SQLite database singleton.
 *
 * WARNING — SINGLETON: Only the first call with a given path is honoured.
 * Subsequent calls with a *different* path are silently ignored. In automated
 * tests, call `closeDb()` between test suites to reset the singleton, or use
 * an in-memory database (`:memory:`).
 */
export function initDb(dbPath: string): DatabaseType {
  if (dbInstance && dbInstance.name === dbPath) return dbInstance;
  const sqlite = new Database(dbPath);
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');
  const db = drizzle(sqlite, { schema });
  migrate(db, { migrationsFolder: migrationsFolder() });
  dbInstance = sqlite;
  return sqlite;
}

export function getDb(): DatabaseType {
  if (!dbInstance) throw new Error('DB not initialized - call initDb() first');
  return dbInstance;
}

export function closeDb(): void {
  if (dbInstance) {
    dbInstance.close();
    dbInstance = null;
  }
}
