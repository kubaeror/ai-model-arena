import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { initDb, closeDb, getDb } from '../../src/db/client.js';
import { insertSchedule, listSchedules } from '../../src/db/query.js';
import { tickScheduler } from '../../src/scheduler/tick.js';
import { getScheduleState } from '../../src/scheduler/manager.js';
import { fetchSync } from '../../src/catalog/sync.js';

const MODELS_DEV = {
  openai: { id: 'openai', name: 'OpenAI', env: ['OPENAI_API_KEY'], models: {
    'gpt-4o': {
      id: 'gpt-4o', name: 'GPT-4o',
      attachment: true, reasoning: false, temperature: true, tool_call: true,
      cost: { input: 2.5, output: 10 },
      limit: { context: 128000, output: 16384 },
    },
  } },
};

function freshDb(): string {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'arena-sched-'));
  // startRun resolves the DB via dbPath() — point it at the temp DB.
  process.env.ARENA_DB_PATH = path.join(tmp, 'test.db');
  process.env.OUTPUT_ROOT = path.join(tmp, 'outputs');
  initDb(process.env.ARENA_DB_PATH);
  return tmp;
}

test('tickScheduler marks a failed startRun as failure and backs off 1h', async () => {
  const tmp = freshDb();
  try {
    await insertSchedule({
      id: 's-bad', scenario: 'express-rest',
      models: ['definitely-not-a-model'],
      cron: '* * * * *', enabled: true,
      createdAt: new Date().toISOString(),
    });
    // Not due yet → untouched.
    const before = (await listSchedules()).find((s) => s.id === 's-bad')!;
    assert.equal(before.next_run, null);

    // Force due: next_run in the past.
    getDb().prepare('UPDATE schedules SET next_run = ? WHERE id = ?').run(new Date(Date.now() - 60000).toISOString(), 's-bad');

    const result = await tickScheduler();
    assert.deepEqual(result.ticked, []);
    assert.deepEqual(result.failures, ['s-bad']);

    const after = (await listSchedules()).find((s) => s.id === 's-bad')!;
    assert.ok(after.next_run, 'next_run should be set after the tick');
    const nextMs = new Date(after.next_run!).getTime();
    assert.ok(nextMs > Date.now() + 30 * 60 * 1000, `expected ~1h backoff, got ${after.next_run}`);

    const state = getScheduleState('s-bad');
    assert.equal(state?.status, 'error');
    assert.equal(state?.totalRuns, 1);
    assert.equal(state?.totalFailures, 1);
    assert.equal(state?.consecutiveFailures, 1);
  } finally {
    closeDb();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('tickScheduler ticks a due schedule and advances next_run', async () => {
  const tmp = freshDb();
  try {
    await insertSchedule({
      id: 's-ok', scenario: 'express-rest',
      models: ['GPT-4o'], cron: '* * * * *', enabled: true,
      createdAt: new Date().toISOString(),
    });
    // Seed the catalog so startRun resolves the model.
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async () => ({
      status: 200, ok: true,
      json: async () => MODELS_DEV,
      text: async () => JSON.stringify(MODELS_DEV),
    } as unknown as Response)) as typeof fetch;
    try {
      await fetchSync('models.dev', { apiUrl: 'https://models.dev/api.json', force: true });
    } finally {
      globalThis.fetch = origFetch;
    }
    getDb().prepare('UPDATE schedules SET next_run = ? WHERE id = ?').run(new Date(Date.now() - 60000).toISOString(), 's-ok');

    const result = await tickScheduler();
    assert.deepEqual(result.ticked, ['s-ok']);
    assert.deepEqual(result.failures, []);

    const after = (await listSchedules()).find((s) => s.id === 's-ok')!;
    assert.ok(after.next_run, 'next_run should advance on success');
    assert.ok(new Date(after.next_run!).getTime() > Date.now());
    const state = getScheduleState('s-ok');
    assert.equal(state?.status, 'idle');
    assert.equal(state?.consecutiveFailures, 0);
    assert.equal(state?.totalRuns, 1);
  } finally {
    closeDb();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
