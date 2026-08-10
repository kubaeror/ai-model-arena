import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { initDb, closeDb } from '../../src/db/client.js';
import { upsertRun, getRunRecord } from '../../src/db/runs.js';
import { stopRun, registerRun, type RunSpec } from '../../src/orchestrator/run-lifecycle.js';

const ORIG_ENV = { ...process.env };

test('stopRun marks per-model rows terminal', async () => {
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
    for (const m of rec?.perModel ?? []) {
      assert.notEqual(m.status, 'running', `model ${m.model} must not stay running`);
      assert.equal(m.status, 'stopped', `model ${m.model} should be stopped`);
    }
  } finally {
    closeDb();
    fs.rmSync(tmp, { recursive: true, force: true });
    process.env = { ...ORIG_ENV };
  }
});

test('stopRun on a completed run keeps terminal statuses intact', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'arena-stoprun2-'));
  process.env.ARENA_DB_PATH = path.join(tmp, 'test.db');
  process.env.OUTPUT_ROOT = path.join(tmp, 'outputs');
  process.env.DB_DRIVER = 'sqlite';
  initDb(process.env.ARENA_DB_PATH);

  try {
    await upsertRun({
      runId: 'stop-2', scenario: 'smoke', models: ['gpt-4o'],
      startedAt: new Date().toISOString(), finishedAt: null, status: 'completed', source: 'cli',
      perModel: [{ model: 'gpt-4o', runId: 'stop-2', status: 'completed' } as never],
      comparisonMdPath: null, comparisonJsonPath: null,
    });

    await stopRun('stop-2');

    const rec = await getRunRecord('stop-2');
    assert.equal(rec?.status, 'stopped');
    assert.equal(rec?.perModel[0]?.status, 'completed', 'terminal model rows must not be regressed');
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
