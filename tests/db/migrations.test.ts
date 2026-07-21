import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { initDb, closeDb } from '../../src/db/client.js';

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
