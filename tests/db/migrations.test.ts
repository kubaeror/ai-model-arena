import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { initDb, closeDb } from '../../src/db/client.js';
import { tables } from '../../src/db/schema-defs.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

type IndexRow = { name: string; tbl_name: string; sql: string | null };

function listNamedIndexes(db: ReturnType<typeof initDb>): IndexRow[] {
  return db.prepare(
    "SELECT name, tbl_name, sql FROM sqlite_master WHERE type='index' AND sql IS NOT NULL ORDER BY name"
  ).all() as IndexRow[];
}

function indexColumns(db: ReturnType<typeof initDb>, name: string): string[] {
  const rows = db.prepare(`PRAGMA index_info('${name}')`).all() as { name: string }[];
  return rows.map((r) => r.name);
}

function readJournal(dir: string): { entries: { idx: number; tag: string }[] } {
  const raw = fs.readFileSync(path.join(ROOT, dir, 'meta', '_journal.json'), 'utf-8');
  return JSON.parse(raw) as { entries: { idx: number; tag: string }[] };
}

function listMigrationTags(dir: string): string[] {
  return fs.readdirSync(path.join(ROOT, dir))
    .filter((f) => f.endsWith('.sql'))
    .map((f) => f.slice(0, -4));
}

const ALL_TABLES = [
  '_migrations', 'providers', 'models', 'model_providers', 'pricing',
  'benchmarks', 'model_runtime_stats', 'catalog_cache_state',
  'anomalies', 'webhooks', 'runs', 'run_models', 'sessions', 'messages',
  'model_calls', 'users', 'roles', 'user_roles', 'audit_log', 'files',
  'prompts', 'prompt_versions', 'output_mappings', 'schedules',
];

test('initDb creates all 24 tables on fresh DB', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'arena-db-'));
  const dbPath = path.join(tmp, 'test.db');
  try {
    const db = initDb(dbPath);
    const tables = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
    ).all() as { name: string }[];
    const names = tables.map(t => t.name);
    for (const expected of ALL_TABLES) {
      assert.ok(names.includes(expected), `missing table: ${expected}`);
    }
    closeDb();
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('initDb is idempotent', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'arena-db-'));
  const dbPath = path.join(tmp, 'test.db');
  try {
    initDb(dbPath);
    closeDb();
    const db = initDb(dbPath);
    const count = db.prepare('SELECT COUNT(*) as c FROM providers').get() as { c: number };
    assert.equal(count.c, 0);
    closeDb();
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('sqlite migration journal idx values are contiguous and unique', () => {
  const { entries } = readJournal('drizzle');
  assert.ok(entries.length > 0, 'journal must have entries');
  entries.forEach((entry, i) => {
    assert.equal(entry.idx, i, `journal entry ${i} (${entry.tag}) should have idx ${i}, strictly increasing by 1 without duplicates or gaps`);
  });
});

test('sqlite migration journal and migration files are mutually consistent', () => {
  const { entries } = readJournal('drizzle');
  const journalTags = new Set(entries.map((e) => e.tag));
  const fileTags = listMigrationTags('drizzle');
  for (const tag of journalTags) {
    assert.ok(fileTags.includes(tag), `journal entry ${tag} has no matching drizzle/${tag}.sql`);
  }
  for (const tag of fileTags) {
    assert.ok(journalTags.has(tag), `orphan migration file drizzle/${tag}.sql is not referenced by the journal`);
  }
});

test('pg migration journal and migration files are mutually consistent', () => {
  const { entries } = readJournal('drizzle/pg');
  const journalTags = new Set(entries.map((e) => e.tag));
  const fileTags = listMigrationTags('drizzle/pg');
  for (const tag of journalTags) {
    assert.ok(fileTags.includes(tag), `journal entry ${tag} has no matching drizzle/pg/${tag}.sql`);
  }
  for (const tag of fileTags) {
    assert.ok(journalTags.has(tag), `orphan migration file drizzle/pg/${tag}.sql is not referenced by the pg journal`);
  }
});

const HOT_QUERY_INDEXES: { name: string; columns: string[] }[] = [
  { name: 'idx_files_model_produced', columns: ['model', 'produced_at'] },
  { name: 'idx_files_tool_produced', columns: ['produced_by_tool', 'produced_at'] },
  { name: 'idx_files_prompt_produced', columns: ['prompt_id', 'produced_at'] },
  { name: 'idx_runs_created_by', columns: ['created_by'] },
  { name: 'idx_runs_status', columns: ['status'] },
  { name: 'idx_run_models_status', columns: ['status'] },
];

test('0020 renumbers legacy cost_ledger duplicates losslessly before creating the unique index', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'arena-db-dedupe-'));
  const dbPath = path.join(tmp, 'test.db');
  // A pre-0020 migration folder: dropping only the journal entry keeps every
  // earlier migration byte-identical to the real folder.
  const partialDir = path.join(tmp, 'drizzle-partial');
  fs.cpSync(path.join(ROOT, 'drizzle'), partialDir, { recursive: true });
  const journalPath = path.join(partialDir, 'meta', '_journal.json');
  const journal = JSON.parse(fs.readFileSync(journalPath, 'utf-8')) as { entries: { tag: string }[] };
  // Truncate at 0020 (not just drop it): any later migration applied first would
  // advance drizzle's high-water mark and make it skip 0020 on the full rerun.
  journal.entries = journal.entries.slice(0, journal.entries.findIndex((e) => e.tag === '0020_cute_shriek'));
  fs.writeFileSync(journalPath, JSON.stringify(journal, null, 2));

  const sqlite = new Database(dbPath);
  try {
    const db = drizzle(sqlite);
    migrate(db, { migrationsFolder: partialDir });

    // Legacy crash-retry window: two rows for the same (run_id, model) with no
    // finalization_attempt column yet.
    sqlite.prepare(
      "INSERT INTO runs (run_id, scenario, models, started_at, status, source) VALUES ('r1', 's', '[\"a\"]', '2026-01-01T00:00:00.000Z', 'completed', 'cli')"
    ).run();
    const insert = sqlite.prepare(
      "INSERT INTO cost_ledger (run_id, model, cost_usd, currency, recorded_at) VALUES ('r1', 'a', ?, 'USD', ?)"
    );
    insert.run(0.01, '2026-01-01T00:00:00.000Z');
    insert.run(0.02, '2026-01-02T00:00:00.000Z');

    migrate(db, { migrationsFolder: path.join(ROOT, 'drizzle') });

    const rows = sqlite.prepare(
      'SELECT id, cost_usd, finalization_attempt FROM cost_ledger WHERE run_id = ? ORDER BY id'
    ).all('r1') as { id: number; cost_usd: number; finalization_attempt: number }[];
    assert.equal(rows.length, 2, 'both legacy rows are preserved: dedupe must not silently drop spend');
    assert.deepEqual(
      rows.map((r) => r.cost_usd).sort((a, b) => a - b),
      [0.01, 0.02],
      'both crash-retry costs survive the migration',
    );
    const attempts = rows.map((r) => r.finalization_attempt);
    assert.equal(new Set(attempts).size, 2, 'legacy rows get distinct finalization attempts');
    assert.ok(attempts.every((a) => a < 0), 'legacy attempts are negative so positive new attempts never collide');

    const index = sqlite.prepare(
      "SELECT name FROM sqlite_master WHERE type='index' AND name = 'uq_cost_ledger_run_model_attempt'"
    ).get();
    assert.ok(index, 'unique index exists after the renumbering');

    const insertAttempt = sqlite.prepare(
      "INSERT INTO cost_ledger (run_id, model, cost_usd, currency, recorded_at, finalization_attempt) VALUES ('r1', 'a', ?, 'USD', ?, ?)"
    );
    insertAttempt.run(0.03, '2026-01-03T00:00:00.000Z', 1);
    assert.throws(
      () => insertAttempt.run(0.04, '2026-01-04T00:00:00.000Z', 1),
      /UNIQUE constraint failed/,
      'the unique index rejects a duplicate positive attempt',
    );
    assert.equal(
      (sqlite.prepare('SELECT COUNT(*) as c FROM cost_ledger WHERE run_id = ?').get('r1') as { c: number }).c,
      3,
      'a new positive attempt coexists with the negative legacy attempts',
    );
  } finally {
    sqlite.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('latest migration adds a nullable runs.reaped_at marker', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'arena-db-reaped-'));
  const dbPath = path.join(tmp, 'test.db');
  try {
    const db = initDb(dbPath);
    const columns = db.prepare("PRAGMA table_info('runs')").all() as
      { name: string; notnull: number; dflt_value: string | null }[];
    const reaped = columns.find((c) => c.name === 'reaped_at');
    assert.ok(reaped, 'runs.reaped_at must exist after migrations');
    assert.equal(reaped.notnull, 0, 'reaped_at is nullable');
    assert.equal(reaped.dflt_value, null, 'reaped_at defaults to NULL');
    closeDb();
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('migrated DB has the hot-query indexes', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'arena-db-'));
  const dbPath = path.join(tmp, 'test.db');
  try {
    const db = initDb(dbPath);
    const names = new Set(listNamedIndexes(db).map((r) => r.name));
    for (const expected of HOT_QUERY_INDEXES) {
      assert.ok(names.has(expected.name), `missing index: ${expected.name}`);
      assert.deepEqual(
        indexColumns(db, expected.name),
        expected.columns,
        `index ${expected.name} columns differ`,
      );
    }
    closeDb();
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('schema-defs index declarations match indexes created by migrations', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'arena-db-'));
  const dbPath = path.join(tmp, 'test.db');
  try {
    const db = initDb(dbPath);
    const declared = new Map<string, { table: string; columns: string[] }>();
    for (const table of tables) {
      for (const ix of 'indexes' in table ? table.indexes : []) {
        declared.set(ix.name, { table: table.name, columns: ix.on });
      }
      for (const [column, def] of Object.entries(table.columns)) {
        if (def.unique && !def.primaryKey) {
          declared.set(`${table.name}_${column}_unique`, { table: table.name, columns: [column] });
        }
      }
    }

    const actual = listNamedIndexes(db);
    const actualNames = new Set(actual.map((r) => r.name));
    for (const [name, spec] of declared) {
      assert.ok(actualNames.has(name), `schema-defs declares ${name} but migrations do not create it`);
      assert.deepEqual(indexColumns(db, name), spec.columns, `index ${name} columns differ between schema-defs and migrations`);
    }
    for (const row of actual) {
      assert.ok(declared.has(row.name), `migration creates ${row.name} (${row.tbl_name}) but schema-defs does not declare it`);
    }
    closeDb();
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
