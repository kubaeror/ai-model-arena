import { test } from 'node:test';
import assert from 'node:assert/strict';
import { initDb, closeDb, getDb } from '../../src/db/client.js';
import { upsertRun, listRuns, getRunRecord, updateRun } from '../../src/db/runs.js';
import type { RunIndexRecord } from '../../src/orchestrator/run-index.js';

function mkRun(runId: string): RunIndexRecord {
  return {
    runId, scenario: 'express-rest', models: ['gpt-4o'], startedAt: new Date().toISOString(),
    finishedAt: null, status: 'running', source: 'cli', perModel: [], comparisonMdPath: null, comparisonJsonPath: null,
  };
}

test('upsertRun inserts then updates a run', async () => {
  initDb(':memory:');
  await upsertRun(mkRun('r1'));
  let rec = getRunRecord('r1');
  assert.equal(rec?.status, 'running');
  await updateRun('r1', (r) => { r.status = 'completed'; r.finishedAt = new Date().toISOString(); });
  rec = getRunRecord('r1');
  assert.equal(rec?.status, 'completed');
  closeDb();
});

test('listRuns returns newest first', async () => {
  initDb(':memory:');
  await upsertRun(mkRun('old'));
  await new Promise(r => setTimeout(r, 10));
  await upsertRun(mkRun('new'));
  const all = listRuns();
  assert.equal(all[0]!.runId, 'new');
  closeDb();
});

test('upsertRun with perModel entries round-trips', async () => {
  initDb(':memory:');
  const r = mkRun('r2');
  r.perModel = [{ model: 'gpt-4o', runId: 'r2', procName: 'p', outputDir: '/o', sandboxDir: '/s', resultPath: '/r', conversationPath: '/c', reportPath: '/m', logFile: '/l', status: 'running' }];
  await upsertRun(r);
  const rec = getRunRecord('r2');
  assert.equal(rec?.perModel.length, 1);
  assert.equal(rec?.perModel[0]!.model, 'gpt-4o');
  closeDb();
});
