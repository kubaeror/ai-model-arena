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
 * Apply indices that can't be expressed as single-statement Drizzle migrations.
 * Called after Drizzle migrations run on each DB init.
 */
function applyRuntimeIndices(sqlite: DatabaseType): void {
  const stmts = [
    `CREATE INDEX IF NOT EXISTS idx_audit_actor_at ON audit_log (actor, "at")`,
    `CREATE INDEX IF NOT EXISTS idx_audit_entity ON audit_log (entity_type, entity_id)`,
    `CREATE INDEX IF NOT EXISTS idx_audit_at ON audit_log ("at")`,
    `CREATE INDEX IF NOT EXISTS idx_audit_action ON audit_log (action)`,
    `CREATE UNIQUE INDEX IF NOT EXISTS uq_run_models_run_model ON run_models (run_id, model)`,
    `CREATE UNIQUE INDEX IF NOT EXISTS uq_user_roles_user_role ON user_roles (user_id, role_id)`,
  ];
  for (const stmt of stmts) {
    try { sqlite.prepare(stmt).run(); } catch { /* index may already exist */ }
  }
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
  sqlite.pragma('wal_autocheckpoint = 1000');
  const db = drizzle(sqlite, { schema });
  migrate(db, { migrationsFolder: migrationsFolder() });
  applyRuntimeIndices(sqlite);
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
