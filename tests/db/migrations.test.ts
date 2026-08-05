import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { initDb, closeDb } from '../../src/db/client.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

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
