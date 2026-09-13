/**
 * Unique-index migration pre-flight.
 *
 * SQLite `0019_modern_greymalkin` / Postgres `0012_supreme_rogue` add the
 * unique indexes `uq_run_models_run_model (run_id, model)` and
 * `uq_user_roles_user_role (user_id, role_id)`. If the target database already
 * contains duplicate keys, index creation aborts inside the migration
 * transaction and every pod initContainer crash-loops. Run this before
 * upgrading:
 *
 *   npx tsx scripts/db/preflight-unique-indexes.ts
 *
 * Exits 1 when duplicates exist (printing the dedupe SQL for the active
 * dialect), 0 when clean or when the tables do not exist yet.
 *
 * Opens the database directly instead of going through `initDb()` so it can
 * inspect databases that have not yet applied the unique-index migration.
 */
import 'dotenv/config';
import fs from 'node:fs';
import Database from 'better-sqlite3';
import pg from 'pg';
import { dbPath } from '../../src/paths.js';

interface DuplicateGroup {
  table: string;
  keys: string;
  count: number;
}

interface TableCheck {
  table: string;
  keyColumns: [string, string];
}

const CHECKS: TableCheck[] = [
  { table: 'run_models', keyColumns: ['run_id', 'model'] },
  { table: 'user_roles', keyColumns: ['user_id', 'role_id'] },
];

function selectSql(table: string, keyColumns: string[], castCount: boolean): string {
  const keys = keyColumns.join(', ');
  return `SELECT ${keys}, COUNT(*)${castCount ? '::int' : ''} AS n FROM ${table} GROUP BY ${keys} HAVING COUNT(*) > 1 ORDER BY n DESC`;
}

function sqliteDedupeSql(table: string, keyColumns: string[]): string {
  return `DELETE FROM ${table} WHERE rowid NOT IN (SELECT MAX(rowid) FROM ${table} GROUP BY ${keyColumns.join(', ')});`;
}

function postgresDedupeSql(table: string, keyColumns: string[]): string {
  const join = keyColumns.map((c) => `a.${c} = b.${c}`).join(' AND ');
  return `DELETE FROM ${table} a USING ${table} b WHERE a.ctid < b.ctid AND ${join};`;
}

function describeRow(row: Record<string, unknown>, keyColumns: string[]): string {
  return `(${keyColumns.map((c) => `${c}=${JSON.stringify(row[c])}`).join(', ')})`;
}

function report(driver: 'sqlite' | 'postgres', groups: DuplicateGroup[], dedupeSql: string[]): number {
  if (groups.length === 0) {
    console.log(`${driver}: no duplicate keys found.`);
    return 0;
  }
  console.error(`${driver}: ${groups.length} duplicate key group(s) found:`);
  for (const group of groups) {
    console.error(`  ${group.table} ${group.keys}: ${group.count} rows`);
  }
  console.error('\nDedupe SQL — review the rows and merge columns worth keeping BEFORE running:');
  for (const stmt of dedupeSql) console.error(`  ${stmt}`);
  console.error('\nRe-run this preflight, then retry the migration.');
  return 1;
}

function preflightSqlite(): number {
  const file = dbPath();
  if (!fs.existsSync(file)) {
    console.log(`sqlite: database ${file} not found; nothing to check.`);
    return 0;
  }
  console.log(`sqlite: ${file}`);
  const db = new Database(file, { readonly: true });
  const groups: DuplicateGroup[] = [];
  const dedupeSql: string[] = [];
  try {
    for (const { table, keyColumns } of CHECKS) {
      const exists = db
        .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
        .get(table);
      if (!exists) {
        console.log(`  ${table}: table missing (fresh database); skipping.`);
        continue;
      }
      const rows = db.prepare(selectSql(table, keyColumns, false)).all() as Record<string, unknown>[];
      for (const row of rows) {
        groups.push({ table, keys: describeRow(row, keyColumns), count: Number(row.n) });
      }
      if (rows.length > 0) dedupeSql.push(sqliteDedupeSql(table, keyColumns));
    }
  } finally {
    db.close();
  }
  return report('sqlite', groups, dedupeSql);
}

async function preflightPostgres(): Promise<number> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is required when DB_DRIVER=postgres');
  console.log('postgres: connecting');
  const pool = new pg.Pool({ connectionString: url, max: 1, connectionTimeoutMillis: 10_000 });
  const groups: DuplicateGroup[] = [];
  const dedupeSql: string[] = [];
  try {
    for (const { table, keyColumns } of CHECKS) {
      const { rows: existsRows } = await pool.query<{ present: boolean }>(
        'SELECT to_regclass($1) IS NOT NULL AS present',
        [table]
      );
      if (existsRows[0]?.present !== true) {
        console.log(`  ${table}: table missing (fresh database); skipping.`);
        continue;
      }
      const { rows } = await pool.query<Record<string, unknown>>(selectSql(table, keyColumns, true));
      for (const row of rows) {
        groups.push({ table, keys: describeRow(row, keyColumns), count: Number(row.n) });
      }
      if (rows.length > 0) dedupeSql.push(postgresDedupeSql(table, keyColumns));
    }
  } finally {
    await pool.end();
  }
  return report('postgres', groups, dedupeSql);
}

console.log('Preflight: uq_run_models_run_model(run_id, model), uq_user_roles_user_role(user_id, role_id)');
const driver = (process.env.DB_DRIVER ?? 'sqlite').toLowerCase();
if (driver === 'postgres') {
  process.exitCode = await preflightPostgres();
} else if (driver === 'sqlite') {
  process.exitCode = preflightSqlite();
} else {
  console.error(`Unsupported DB_DRIVER "${driver}" (expected "sqlite" or "postgres")`);
  process.exitCode = 2;
}
