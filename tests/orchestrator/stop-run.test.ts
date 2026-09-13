import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { initDb, closeDb } from '../../src/db/client.js';
import { transitionTaskState, createSession } from '../../src/db/query.js';
import { InMemoryQueue } from '../../src/queue/in-memory.js';
import type { Task } from '../../src/queue/types.js';
import { upsertRun, getRunRecord } from '../../src/db/runs.js';
import { stopRun, restartRun, registerRun, isRunCancelled, isStaleRunningRun, type RunSpec } from '../../src/orchestrator/run-lifecycle.js';

const ORIG_ENV = { ...process.env };

test('stopRun marks the run stopped and leaves model rows for the runners to ack', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'arena-stoprun-'));
  process.env.ARENA_DB_PATH = path.join(tmp, 'test.db');
  process.env.OUTPUT_ROOT = path.join(tmp, 'outputs');
  process.env.DB_DRIVER = 'sqlite';
  initDb(process.env.ARENA_DB_PATH);

  try {
    await upsertRun({
      runId: 'stop-1', scenario: 'smoke', models: ['gpt-4o'],
      startedAt: new Date().toISOString(), finishedAt: null, status: 'running', source: 'cli',
      perModel: [{ model: 'gpt-4o', runId: 'stop-1', status: 'running' } as never],
      comparisonMdPath: null, comparisonJsonPath: null,
    });

    await stopRun('stop-1');

    const rec = await getRunRecord('stop-1');
    assert.equal(rec?.status, 'stopped');
    assert.ok(rec?.finishedAt, 'finishedAt should be set');
    assert.equal(await isRunCancelled('stop-1'), true, 'stop must set the cancel signal');
    // Rows are the per-model acknowledgements: stopRun must leave them for each
    // runner to terminalize once it observes the cancellation.
    assert.equal(rec?.perModel[0]?.status, 'running', 'stopRun must not force-terminalize an executing row');

    // The terminal guard must let the runner ack running -> stopped.
    await transitionTaskState('stop-1', 'gpt-4o', 'stopped');
    assert.equal((await getRunRecord('stop-1'))?.perModel[0]?.status, 'stopped', 'running -> stopped must be permitted');

    // Called again on the now-stopped (terminal) run it must not move the stop
    // timestamp that anchors the finalize grace window.
    const finishedAt = (await getRunRecord('stop-1'))?.finishedAt;
    await stopRun('stop-1');
    assert.equal((await getRunRecord('stop-1'))?.finishedAt, finishedAt, 'a second stop is a no-op');
  } finally {
    closeDb();
    fs.rmSync(tmp, { recursive: true, force: true });
    process.env = { ...ORIG_ENV };
  }
});

test('stopRun leaves a claimed row and the runner can ack claimed -> stopped', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'arena-stoprun-claimed-'));
  process.env.ARENA_DB_PATH = path.join(tmp, 'test.db');
  process.env.OUTPUT_ROOT = path.join(tmp, 'outputs');
  process.env.DB_DRIVER = 'sqlite';
  initDb(process.env.ARENA_DB_PATH);

  try {
    await upsertRun({
      runId: 'stop-claimed', scenario: 'smoke', models: ['gpt-4o'],
      startedAt: new Date().toISOString(), finishedAt: null, status: 'running', source: 'cli',
      perModel: [{ model: 'gpt-4o', runId: 'stop-claimed', status: 'claimed' } as never],
      comparisonMdPath: null, comparisonJsonPath: null,
    });

    await stopRun('stop-claimed');
    assert.equal((await getRunRecord('stop-claimed'))?.perModel[0]?.status, 'claimed', 'stopRun must not touch claimed rows');

    await transitionTaskState('stop-claimed', 'gpt-4o', 'stopped');
    assert.equal((await getRunRecord('stop-claimed'))?.perModel[0]?.status, 'stopped', 'claimed -> stopped must be permitted');
  } finally {
    closeDb();
    fs.rmSync(tmp, { recursive: true, force: true });
    process.env = { ...ORIG_ENV };
  }
});

test('stopRun on a completed run is a no-op (never regresses to stopped)', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'arena-stoprun2-'));
  process.env.ARENA_DB_PATH = path.join(tmp, 'test.db');
  process.env.OUTPUT_ROOT = path.join(tmp, 'outputs');
  process.env.DB_DRIVER = 'sqlite';
  initDb(process.env.ARENA_DB_PATH);

  const finishedAt = '2026-01-01T00:00:00.000Z';
  try {
    await upsertRun({
      runId: 'stop-2', scenario: 'smoke', models: ['gpt-4o'],
      startedAt: new Date().toISOString(), finishedAt, status: 'completed', source: 'cli',
      perModel: [{ model: 'gpt-4o', runId: 'stop-2', status: 'completed' } as never],
      comparisonMdPath: null, comparisonJsonPath: null,
    });

    await stopRun('stop-2');

    const rec = await getRunRecord('stop-2');
    assert.equal(rec?.status, 'completed', 'a finalized run must not regress to stopped');
    assert.equal(rec?.finishedAt, finishedAt, 'finishedAt must not change');
    assert.equal(rec?.perModel[0]?.status, 'completed', 'terminal model rows must not be regressed');
    assert.equal(await isRunCancelled('stop-2'), false, 'no-op stop must not record a cancellation signal');
  } finally {
    closeDb();
    fs.rmSync(tmp, { recursive: true, force: true });
    process.env = { ...ORIG_ENV };
  }
});

test('restartRun resets a finalizing run to running', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'arena-restart-fin-'));
  process.env.ARENA_DB_PATH = path.join(tmp, 'test.db');
  process.env.OUTPUT_ROOT = path.join(tmp, 'outputs');
  process.env.DB_DRIVER = 'sqlite';
  initDb(process.env.ARENA_DB_PATH);

  try {
    await upsertRun({
      runId: 'restart-fin', scenario: 'smoke', models: ['gpt-4o'],
      startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(),
      status: 'finalizing', source: 'cli',
      perModel: [{ model: 'gpt-4o', runId: 'restart-fin', status: 'completed' } as never],
      comparisonMdPath: null, comparisonJsonPath: null,
    });

    await restartRun('restart-fin');

    const rec = await getRunRecord('restart-fin');
    assert.equal(rec?.status, 'running', 'restart must clear the finalizing claim');
    assert.equal(rec?.finishedAt, null, 'restart must clear finishedAt');
    assert.equal(rec?.perModel[0]?.status, 'running', 'restart must reset model rows');
  } finally {
    closeDb();
    fs.rmSync(tmp, { recursive: true, force: true });
    process.env = { ...ORIG_ENV };
  }
});

test('restartRun refreshes started_at so an old run is not immediately reap-eligible', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'arena-restart-stale-'));
  process.env.ARENA_DB_PATH = path.join(tmp, 'test.db');
  process.env.OUTPUT_ROOT = path.join(tmp, 'outputs');
  process.env.DB_DRIVER = 'sqlite';
  initDb(process.env.ARENA_DB_PATH);

  try {
    await upsertRun({
      runId: 'restart-stale', scenario: 'smoke', models: ['gpt-4o'],
      startedAt: new Date(Date.now() - 7 * 60 * 60_000).toISOString(),
      finishedAt: null, status: 'running', source: 'dashboard',
      perModel: [{ model: 'gpt-4o', runId: 'restart-stale', status: 'running' } as never],
      comparisonMdPath: null, comparisonJsonPath: null,
    });

    const before = (await getRunRecord('restart-stale'))!;
    assert.equal(isStaleRunningRun(before), true, 'a 7h-old running run is stale before restart');

    await restartRun('restart-stale');

    const rec = (await getRunRecord('restart-stale'))!;
    assert.ok(
      Date.now() - Date.parse(rec.startedAt) < 60_000,
      'restart must stamp a fresh started_at, not the original start',
    );
    assert.equal(isStaleRunningRun(rec), false, 'a freshly restarted run must not be immediately reap-eligible');
  } finally {
    closeDb();
    fs.rmSync(tmp, { recursive: true, force: true });
    process.env = { ...ORIG_ENV };
  }
});

test('restartRun carries promptId/promptVersion from the run session', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'arena-restart-prompt-'));
  process.env.ARENA_DB_PATH = path.join(tmp, 'test.db');
  process.env.OUTPUT_ROOT = path.join(tmp, 'outputs');
  process.env.DB_DRIVER = 'sqlite';
  initDb(process.env.ARENA_DB_PATH);

  try {
    await upsertRun({
      runId: 'restart-prompt', scenario: 'smoke', models: ['gpt-4o'],
      startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(),
      status: 'completed', source: 'dashboard',
      perModel: [{ model: 'gpt-4o', runId: 'restart-prompt', status: 'completed' } as never],
      comparisonMdPath: null, comparisonJsonPath: null,
    });
    const now = new Date().toISOString();
    await createSession({
      id: 'restart-prompt-gpt-4o', promptId: 'prompt-1', promptVersion: 3,
      model: 'gpt-4o', status: 'completed', createdAt: now, updatedAt: now,
    });

    const captured: Task[] = [];
    const orig = InMemoryQueue.prototype.enqueue;
    InMemoryQueue.prototype.enqueue = async function (task: Task): Promise<void> { captured.push(task); };
    try {
      await restartRun('restart-prompt');
    } finally {
      InMemoryQueue.prototype.enqueue = orig;
    }

    assert.equal(captured.length, 1, 'restart must enqueue one task');
    assert.equal(captured[0]?.promptId, 'prompt-1', 'restart must preserve the prompt id');
    assert.equal(captured[0]?.promptVersion, 3, 'restart must preserve the prompt version');
  } finally {
    closeDb();
    fs.rmSync(tmp, { recursive: true, force: true });
    process.env = { ...ORIG_ENV };
  }
});

test('transitionTaskState never moves a terminal row to a conflicting terminal status', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'arena-transition-guard-'));
  process.env.ARENA_DB_PATH = path.join(tmp, 'test.db');
  process.env.OUTPUT_ROOT = path.join(tmp, 'outputs');
  process.env.DB_DRIVER = 'sqlite';
  initDb(process.env.ARENA_DB_PATH);

  try {
    const mk = (runId: string, status: string) => upsertRun({
      runId, scenario: 'smoke', models: ['gpt-4o'],
      startedAt: new Date().toISOString(), finishedAt: null, status: 'running', source: 'cli',
      perModel: [{ model: 'gpt-4o', runId, status } as never],
      comparisonMdPath: null, comparisonJsonPath: null,
    });
    await mk('guard-stopped', 'running');
    await mk('guard-retry', 'running');

    await transitionTaskState('guard-stopped', 'gpt-4o', 'stopped');
    await transitionTaskState('guard-stopped', 'gpt-4o', 'completed');
    let rec = await getRunRecord('guard-stopped');
    assert.equal(rec?.perModel[0]?.status, 'stopped', 'stopped must never be overwritten by completed');

    await transitionTaskState('guard-stopped', 'gpt-4o', 'failed');
    rec = await getRunRecord('guard-stopped');
    assert.equal(rec?.perModel[0]?.status, 'stopped', 'stopped must never be overwritten by failed');

    await transitionTaskState('guard-retry', 'gpt-4o', 'failed');
    await transitionTaskState('guard-retry', 'gpt-4o', 'completed');
    rec = await getRunRecord('guard-retry');
    assert.equal(rec?.perModel[0]?.status, 'failed', 'failed must never be overwritten by completed directly');

    await transitionTaskState('guard-retry', 'gpt-4o', 'claimed');
    await transitionTaskState('guard-retry', 'gpt-4o', 'running');
    await transitionTaskState('guard-retry', 'gpt-4o', 'completed');
    rec = await getRunRecord('guard-retry');
    assert.equal(rec?.perModel[0]?.status, 'completed', 'retries must re-enter through claimed/running');
  } finally {
    closeDb();
    fs.rmSync(tmp, { recursive: true, force: true });
    process.env = { ...ORIG_ENV };
  }
});

function makeSpec(runId: string, model: string): RunSpec {
  return {
    runId,
    scenario: 'smoke',
    ts: 't',
    startedAt: new Date().toISOString(),
    models: [{
      model,
      providerId: 'openai',
      outputDir: `/tmp/${runId}/out`,
      sandboxDir: `/tmp/${runId}/out/files`,
      resultPath: `/tmp/${runId}/out/result.json`,
      conversationPath: `/tmp/${runId}/out/conversation.json`,
      reportPath: `/tmp/${runId}/out/report.md`,
      logFile: `/tmp/${runId}/out/runner.log`,
    }],
  };
}

test('registerRun does not clobber a terminal run', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'arena-register-'));
  process.env.ARENA_DB_PATH = path.join(tmp, 'test.db');
  process.env.OUTPUT_ROOT = path.join(tmp, 'outputs');
  process.env.DB_DRIVER = 'sqlite';
  initDb(process.env.ARENA_DB_PATH);

  try {
    const spec = makeSpec('reg-1', 'gpt-4o');
    await upsertRun({
      runId: spec.runId, scenario: spec.scenario, models: [spec.models[0]!.model],
      startedAt: spec.startedAt, finishedAt: new Date().toISOString(), status: 'stopped', source: 'cli',
      perModel: [{ model: 'gpt-4o', runId: spec.runId, status: 'stopped' } as never],
      comparisonMdPath: null, comparisonJsonPath: null,
    });

    // A late registration (crash between finalize and register) must not
    // resurrect the stopped run.
    await registerRun(spec, 'cli');

    const rec = await getRunRecord(spec.runId);
    assert.equal(rec?.status, 'stopped', 'registerRun must not resurrect a terminal run');
    assert.equal(rec?.perModel[0]?.status, 'stopped', 'per-model row must not be reset to running');
  } finally {
    closeDb();
    fs.rmSync(tmp, { recursive: true, force: true });
    process.env = { ...ORIG_ENV };
  }
});
