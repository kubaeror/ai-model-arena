import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { initDb, closeDb } from '../../src/db/client.js';
import { upsertRun } from '../../src/db/runs.js';
import { canSubscribeToRun } from '../../src/dashboard-server/live.js';

const ORIG_ENV = { ...process.env };

test('canSubscribeToRun denies viewers who do not own the run', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'arena-ws-owner-'));
  process.env.ARENA_DB_PATH = path.join(tmp, 'test.db');
  process.env.OUTPUT_ROOT = path.join(tmp, 'outputs');
  process.env.DB_DRIVER = 'sqlite';
  initDb(process.env.ARENA_DB_PATH);

  try {
    await upsertRun({
      runId: 'run-owned-by-alice', scenario: 'smoke', models: ['gpt-4o'],
      startedAt: new Date().toISOString(), finishedAt: null, status: 'running', source: 'cli',
      perModel: [{ model: 'gpt-4o', runId: 'run-owned-by-alice', status: 'running' } as never],
      comparisonMdPath: null, comparisonJsonPath: null, createdBy: 'alice',
    });

    assert.equal(await canSubscribeToRun({ sub: 'bob', role: 'viewer' }, 'run-owned-by-alice'), false);
    assert.equal(await canSubscribeToRun({ sub: 'alice', role: 'viewer' }, 'run-owned-by-alice'), true);
    assert.equal(await canSubscribeToRun({ sub: 'bob', role: 'admin' }, 'run-owned-by-alice'), true);
    // Unknown run → deny.
    assert.equal(await canSubscribeToRun({ sub: 'admin', role: 'admin' }, 'no-such-run'), false);
  } finally {
    closeDb();
    fs.rmSync(tmp, { recursive: true, force: true });
    process.env = { ...ORIG_ENV };
  }
});

test('canSubscribeToRun default-denies ownerless runs to non-admins', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'arena-ws-owner2-'));
  process.env.ARENA_DB_PATH = path.join(tmp, 'test.db');
  process.env.OUTPUT_ROOT = path.join(tmp, 'outputs');
  process.env.DB_DRIVER = 'sqlite';
  initDb(process.env.ARENA_DB_PATH);

  try {
    await upsertRun({
      runId: 'legacy-run', scenario: 'smoke', models: ['gpt-4o'],
      startedAt: new Date().toISOString(), finishedAt: null, status: 'running', source: 'cli',
      perModel: [{ model: 'gpt-4o', runId: 'legacy-run', status: 'running' } as never],
      comparisonMdPath: null, comparisonJsonPath: null,
    });

    assert.equal(await canSubscribeToRun({ sub: 'alice', role: 'viewer' }, 'legacy-run'), false);
    assert.equal(await canSubscribeToRun({ sub: 'bob', role: 'admin' }, 'legacy-run'), true);
  } finally {
    closeDb();
    fs.rmSync(tmp, { recursive: true, force: true });
    process.env = { ...ORIG_ENV };
  }
});
