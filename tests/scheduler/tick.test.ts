import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { initDb, closeDb, getDb } from '../../src/db/client.js';
import { insertSchedule, listSchedules } from '../../src/db/query.js';
import { tickScheduler } from '../../src/scheduler/tick.js';
import { getScheduleState, loadSchedulesConfig, syncSchedulesToDb, resetSchedulesCache } from '../../src/scheduler/manager.js';
import { fetchSync } from '../../src/catalog/sync.js';
import { dump } from 'js-yaml';

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

test('tickScheduler passes schedule options (timeoutMs, forceBudget) into startRun', async (t) => {
  const tmp = freshDb();
  const configPath = path.join(tmp, 'schedules.yaml');
  try {
    fs.writeFileSync(configPath, dump({
      schedules: [
        {
          id: 's-opt', scenario: 'express-rest', models: ['gpt-4o'],
          cron: '* * * * *', enabled: true,
          options: { forceBudget: true, timeoutMs: 12345 },
        },
        {
          id: 's-false', scenario: 'express-rest', models: ['gpt-4o'],
          cron: '* * * * *', enabled: true,
          options: { forceBudget: false, timeoutMs: 54321 },
        },
        {
          id: 's-plain', scenario: 'express-rest', models: ['gpt-4o'],
          cron: '* * * * *', enabled: true,
        },
      ],
    }));
    loadSchedulesConfig(configPath);
    await syncSchedulesToDb(configPath);
    for (const id of ['s-opt', 's-false', 's-plain']) {
      getDb().prepare('UPDATE schedules SET next_run = ? WHERE id = ?').run(new Date(Date.now() - 60000).toISOString(), id);
    }

    const calls: Array<Record<string, unknown>> = [];
    t.mock.module('../../src/orchestrator/run-lifecycle.js', {
      exports: {
        startRun: async (opts: Record<string, unknown>) => {
          calls.push(opts);
          return { runId: 'x', scenario: opts.scenario, ts: 't', startedAt: 'now', models: [] };
        },
      },
    });

    const result = await tickScheduler();
    assert.deepEqual(result.ticked.sort(), ['s-false', 's-opt', 's-plain']);
    assert.equal(calls.length, 3);
    assert.deepEqual(calls.find((c) => c.timeoutMs === 12345), {
      scenario: 'express-rest', models: ['gpt-4o'], source: 'scheduler',
      forceBudget: true, timeoutMs: 12345,
    });
    assert.deepEqual(calls.find((c) => c.timeoutMs === 54321), {
      scenario: 'express-rest', models: ['gpt-4o'], source: 'scheduler',
      forceBudget: false, timeoutMs: 54321,
    });
    assert.deepEqual(calls.find((c) => c.timeoutMs === undefined), {
      scenario: 'express-rest', models: ['gpt-4o'], source: 'scheduler',
    });
  } finally {
    resetSchedulesCache();
    closeDb();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('tickScheduler backs off failures by SCHEDULER_FAILURE_BACKOFF_MS', async (t) => {
  const tmp = freshDb();
  process.env.SCHEDULER_FAILURE_BACKOFF_MS = '5000';
  try {
    await insertSchedule({
      id: 's-bad2', scenario: 'express-rest', models: ['gpt-4o'],
      cron: '* * * * *', enabled: true, createdAt: new Date().toISOString(),
    });
    getDb().prepare('UPDATE schedules SET next_run = ? WHERE id = ?').run(new Date(Date.now() - 60000).toISOString(), 's-bad2');

    t.mock.module('../../src/orchestrator/run-lifecycle.js', {
      exports: {
        startRun: async () => { throw new Error('boom'); },
      },
    });

    const result = await tickScheduler();
    assert.deepEqual(result.ticked, []);
    assert.deepEqual(result.failures, ['s-bad2']);

    const after = (await listSchedules()).find((s) => s.id === 's-bad2')!;
    const nextMs = new Date(after.next_run!).getTime();
    assert.ok(nextMs > Date.now() + 2000, `expected env-derived backoff, got ${after.next_run}`);
    assert.ok(nextMs < Date.now() + 60000, `expected env-derived backoff, got ${after.next_run}`);
  } finally {
    delete process.env.SCHEDULER_FAILURE_BACKOFF_MS;
    closeDb();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('empty SCHEDULER_FAILURE_BACKOFF_MS falls back to the 1h default', async (t) => {
  const tmp = freshDb();
  process.env.SCHEDULER_FAILURE_BACKOFF_MS = '';
  try {
    await insertSchedule({
      id: 's-empty', scenario: 'express-rest', models: ['gpt-4o'],
      cron: '* * * * *', enabled: true, createdAt: new Date().toISOString(),
    });
    getDb().prepare('UPDATE schedules SET next_run = ? WHERE id = ?').run(new Date(Date.now() - 60000).toISOString(), 's-empty');

    t.mock.module('../../src/orchestrator/run-lifecycle.js', {
      exports: {
        startRun: async () => { throw new Error('boom'); },
      },
    });

    const result = await tickScheduler();
    assert.deepEqual(result.ticked, []);
    assert.deepEqual(result.failures, ['s-empty']);

    const after = (await listSchedules()).find((s) => s.id === 's-empty')!;
    const nextMs = new Date(after.next_run!).getTime();
    assert.ok(nextMs > Date.now() + 30 * 60 * 1000, `expected ~1h default backoff for empty env, got ${after.next_run}`);
  } finally {
    delete process.env.SCHEDULER_FAILURE_BACKOFF_MS;
    closeDb();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('scheduler-tick entrypoint loads schedules config before ticking (production path)', async (t) => {
  const tmp = freshDb();
  const configPath = path.join(tmp, 'schedules.yaml');
  try {
    fs.writeFileSync(configPath, dump({
      schedules: [{
        id: 's-entry', scenario: 'express-rest', models: ['gpt-4o'],
        cron: '* * * * *', enabled: true,
        options: { forceBudget: false, timeoutMs: 9876 },
      }],
    }));
    loadSchedulesConfig(configPath);
    await syncSchedulesToDb(configPath);
    getDb().prepare('UPDATE schedules SET next_run = ? WHERE id = ?').run(new Date(Date.now() - 60000).toISOString(), 's-entry');
    // Drop the warm cache: the entrypoint must (re)load the config itself,
    // exactly as the k8s CronJob process does on every tick.
    resetSchedulesCache();

    const calls: Array<Record<string, unknown>> = [];
    t.mock.module('../../src/orchestrator/run-lifecycle.js', {
      exports: {
        startRun: async (opts: Record<string, unknown>) => {
          calls.push(opts);
          return { runId: 'x', scenario: opts.scenario, ts: 't', startedAt: 'now', models: [] };
        },
      },
    });

    process.env.SCHEDULES_PATH = configPath;
    try {
      const { runSchedulerTick } = await import('../../src/scripts/scheduler-tick.js');
      await runSchedulerTick();
    } finally {
      delete process.env.SCHEDULES_PATH;
    }

    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0], {
      scenario: 'express-rest', models: ['gpt-4o'], source: 'scheduler',
      forceBudget: false, timeoutMs: 9876,
    });
  } finally {
    resetSchedulesCache();
    closeDb();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
