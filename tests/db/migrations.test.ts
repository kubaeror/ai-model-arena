import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
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
