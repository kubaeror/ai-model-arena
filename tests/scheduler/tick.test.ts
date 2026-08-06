import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { initDb, closeDb, getDb } from '../../src/db/client.js';
import { insertSchedule, listSchedules, getScheduleRow } from '../../src/db/query.js';
import { tickScheduler } from '../../src/scheduler/tick.js';
import { getScheduleState, loadSchedulesConfig, syncSchedulesToDb, resetSchedulesCache } from '../../src/scheduler/manager.js';
import type { RunStartOptions } from '../../src/orchestrator/run-lifecycle.js';
import { dump } from 'js-yaml';

function freshDb(): string {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'arena-sched-'));
  // startRun resolves the DB via dbPath() — point it at the temp DB.
  process.env.ARENA_DB_PATH = path.join(tmp, 'test.db');
  process.env.OUTPUT_ROOT = path.join(tmp, 'outputs');
  process.env.AI_ARENA_ROOT = tmp;
  initDb(process.env.ARENA_DB_PATH);
  return tmp;
}

test('tick persists schedule status to the DB', async () => {
  const tmp = freshDb();
  try {
    await insertSchedule({
      id: 's-persist', scenario: 'express-rest',
      models: ['gpt-4o'], cron: '* * * * *', enabled: true,
      createdAt: new Date().toISOString(),
    });
    getDb().prepare('UPDATE schedules SET next_run = ? WHERE id = ?').run(new Date(Date.now() - 60000).toISOString(), 's-persist');

    const failing = async (): Promise<unknown> => { throw new Error('boom'); };
    const failResult = await tickScheduler({ startRunFn: failing });
    assert.deepEqual(failResult.ticked, []);
    assert.deepEqual(failResult.failures, ['s-persist']);

    const row = await getScheduleRow('s-persist');
    assert.equal(row?.last_status, 'error');
    assert.equal(row?.consecutive_failures, 1);
    assert.equal(row?.total_runs, 1);
    assert.equal(row?.total_failures, 1);
    assert.ok(row?.last_error, 'last_error should be set on failure');

    // Force due again, then succeed: consecutive failures reset, counters advance.
    getDb().prepare('UPDATE schedules SET next_run = ? WHERE id = ?').run(new Date(Date.now() - 60000).toISOString(), 's-persist');
    const ok = async (): Promise<unknown> => ({ runId: 'x', scenario: 'express-rest', ts: 't', startedAt: 'now', models: [] });
    const okResult = await tickScheduler({ startRunFn: ok });
    assert.deepEqual(okResult.ticked, ['s-persist']);
    assert.deepEqual(okResult.failures, []);

    const row2 = await getScheduleRow('s-persist');
    assert.equal(row2?.last_status, 'idle');
    assert.equal(row2?.consecutive_failures, 0);
    assert.equal(row2?.total_runs, 2);
    assert.equal(row2?.total_failures, 1);
  } finally {
    delete process.env.AI_ARENA_ROOT;
    closeDb();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

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

    const startRunFn = async () => { throw new Error('boom'); };
    const result = await tickScheduler({ startRunFn });
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
    delete process.env.AI_ARENA_ROOT;
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
    getDb().prepare('UPDATE schedules SET next_run = ? WHERE id = ?').run(new Date(Date.now() - 60000).toISOString(), 's-ok');

    const startRunFn = async () => ({ runId: 'x', scenario: 'express-rest', ts: 't', startedAt: 'now', models: [] });
    const result = await tickScheduler({ startRunFn });
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
    delete process.env.AI_ARENA_ROOT;
    closeDb();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('tickScheduler passes schedule options (timeoutMs, forceBudget) into startRun', async () => {
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
    const startRunFn = async (o: RunStartOptions) => { calls.push({ ...o }); return { runId: 'x', scenario: o.scenario, ts: 't', startedAt: 'now', models: [] }; };

    const result = await tickScheduler({ startRunFn });
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
    delete process.env.AI_ARENA_ROOT;
    closeDb();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('tickScheduler backs off failures by SCHEDULER_FAILURE_BACKOFF_MS', async () => {
  const tmp = freshDb();
  process.env.SCHEDULER_FAILURE_BACKOFF_MS = '5000';
  try {
    await insertSchedule({
      id: 's-bad2', scenario: 'express-rest', models: ['gpt-4o'],
      cron: '* * * * *', enabled: true, createdAt: new Date().toISOString(),
    });
    getDb().prepare('UPDATE schedules SET next_run = ? WHERE id = ?').run(new Date(Date.now() - 60000).toISOString(), 's-bad2');

    const startRunFn = async () => { throw new Error('boom'); };

    const result = await tickScheduler({ startRunFn });
    assert.deepEqual(result.ticked, []);
    assert.deepEqual(result.failures, ['s-bad2']);

    const after = (await listSchedules()).find((s) => s.id === 's-bad2')!;
    const nextMs = new Date(after.next_run!).getTime();
    assert.ok(nextMs > Date.now() + 2000, `expected env-derived backoff, got ${after.next_run}`);
    assert.ok(nextMs < Date.now() + 60000, `expected env-derived backoff, got ${after.next_run}`);
  } finally {
    delete process.env.SCHEDULER_FAILURE_BACKOFF_MS;
    delete process.env.AI_ARENA_ROOT;
    closeDb();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('empty SCHEDULER_FAILURE_BACKOFF_MS falls back to the 1h default', async () => {
  const tmp = freshDb();
  process.env.SCHEDULER_FAILURE_BACKOFF_MS = '';
  try {
    await insertSchedule({
      id: 's-empty', scenario: 'express-rest', models: ['gpt-4o'],
      cron: '* * * * *', enabled: true, createdAt: new Date().toISOString(),
    });
    getDb().prepare('UPDATE schedules SET next_run = ? WHERE id = ?').run(new Date(Date.now() - 60000).toISOString(), 's-empty');

    const startRunFn = async () => { throw new Error('boom'); };

    const result = await tickScheduler({ startRunFn });
    assert.deepEqual(result.ticked, []);
    assert.deepEqual(result.failures, ['s-empty']);

    const after = (await listSchedules()).find((s) => s.id === 's-empty')!;
    const nextMs = new Date(after.next_run!).getTime();
    assert.ok(nextMs > Date.now() + 30 * 60 * 1000, `expected ~1h default backoff for empty env, got ${after.next_run}`);
  } finally {
    delete process.env.SCHEDULER_FAILURE_BACKOFF_MS;
    delete process.env.AI_ARENA_ROOT;
    closeDb();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('scheduler-tick entrypoint loads schedules config before ticking (production path)', async () => {
  const tmp = freshDb();
  const configPath = path.join(tmp, 'schedules.yaml');
  try {
    fs.writeFileSync(configPath, dump({
      schedules: [
        {
          id: 's-entry', scenario: 'express-rest', models: ['gpt-4o'],
          cron: '* * * * *', enabled: true,
          options: { forceBudget: false, timeoutMs: 9876 },
        },
        {
          id: 's-opt', scenario: 'express-rest', models: ['gpt-4o'],
          cron: '* * * * *', enabled: true,
          options: { forceBudget: true, timeoutMs: 12345 },
        },
      ],
    }));
    loadSchedulesConfig(configPath);
    await syncSchedulesToDb(configPath);
    for (const id of ['s-entry', 's-opt']) {
      getDb().prepare('UPDATE schedules SET next_run = ? WHERE id = ?').run(new Date(Date.now() - 60000).toISOString(), id);
    }
    // Drop the warm cache: the entrypoint must (re)load the config itself,
    // exactly as the k8s CronJob process does on every tick.
    resetSchedulesCache();

    const calls: Array<Record<string, unknown>> = [];
    const startRunFn = async (o: RunStartOptions) => { calls.push({ ...o }); return { runId: 'x', scenario: o.scenario, ts: 't', startedAt: 'now', models: [] }; };

    process.env.SCHEDULES_PATH = configPath;
    try {
      const { runSchedulerTick } = await import('../../src/scripts/scheduler-tick.js');
      await runSchedulerTick({ startRunFn });
    } finally {
      delete process.env.SCHEDULES_PATH;
    }

    assert.equal(calls.length, 2);
    assert.deepEqual(calls.find((c) => c.timeoutMs === 9876), {
      scenario: 'express-rest', models: ['gpt-4o'], source: 'scheduler',
      forceBudget: false, timeoutMs: 9876,
    });
    assert.deepEqual(calls.find((c) => c.timeoutMs === 12345), {
      scenario: 'express-rest', models: ['gpt-4o'], source: 'scheduler',
      forceBudget: true, timeoutMs: 12345,
    });
  } finally {
    resetSchedulesCache();
    delete process.env.AI_ARENA_ROOT;
    closeDb();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
