import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { initDb, closeDb, getDb } from '../../src/db/client.js';
import { upsertRun, getRunRecord } from '../../src/db/runs.js';
import { transitionTaskState } from '../../src/db/query.js';
import { attemptFinalizeCandidate, reconcileStaleRunningRun } from '../../src/dashboard-server/live.js';
import { createLogger } from '../../src/logger/pino-logger.js';
import { markRunCancelled, clearRunCancelled } from '../../src/orchestrator/run-signals.js';
import { stopRun, prepareRunFinalization } from '../../src/orchestrator/run-lifecycle.js';

const logger = createLogger('test:stop-finalize', 'warn');

let tmp = '';
let outputs = '';

function modelDir(runId: string, model = 'alpha'): string {
  return path.join(outputs, model, runId);
}

function writeResultFile(runId: string, costUsd: number, model = 'alpha'): string {
  const dir = modelDir(runId, model);
  const resultPath = path.join(dir, 'result.json');
  fs.mkdirSync(path.join(dir, 'files'), { recursive: true });
  fs.writeFileSync(resultPath, JSON.stringify({
    model, scenario: 'basic', runId, success: false,
    costUsd,
    tokenUsage: { prompt: 100, completion: 50, total: 150 },
    turnsUsed: 1, maxTurns: 5, totalToolCalls: 0, toolsCalled: [],
    stopReason: 'cancelled', errors: [], durationMs: 10,
    startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(),
  }, null, 2));
  return resultPath;
}

interface SeedOpts {
  runStatus?: 'running' | 'stopped';
  modelStatus?: string;
  finishedAt?: string | null;
  startedAt?: string;
}

function modelEntry(runId: string, model: string, status: string): Record<string, unknown> {
  const dir = modelDir(runId, model);
  return {
    model, runId, outputDir: dir, sandboxDir: path.join(dir, 'files'),
    resultPath: path.join(dir, 'result.json'),
    conversationPath: path.join(dir, 'conversation.json'),
    reportPath: path.join(dir, 'report.md'), logFile: path.join(dir, 'runner.log'),
    status,
  };
}

async function seedModels(
  runId: string,
  models: Array<{ model: string; status: string }>,
  opts: SeedOpts = {},
): Promise<void> {
  await upsertRun({
    runId, scenario: 'basic', models: models.map((m) => m.model),
    startedAt: opts.startedAt ?? new Date().toISOString(),
    finishedAt: opts.finishedAt !== undefined ? opts.finishedAt : new Date().toISOString(),
    status: opts.runStatus ?? 'stopped', source: 'dashboard',
    perModel: models.map((m) => modelEntry(runId, m.model, m.status) as never),
    comparisonMdPath: null, comparisonJsonPath: null,
  });
}

async function seedRun(runId: string, opts: SeedOpts = {}): Promise<void> {
  await seedModels(runId, [{ model: 'alpha', status: opts.modelStatus ?? 'stopped' }], opts);
}

function ledgerRows(runId: string): Array<{ cost_usd: number }> {
  return getDb().prepare('SELECT cost_usd FROM cost_ledger WHERE run_id = ?').all(runId) as Array<{ cost_usd: number }>;
}

function notificationCount(runId: string): number {
  const rows = getDb().prepare('SELECT payload_json FROM notifications').all() as Array<{ payload_json: string }>;
  return rows.filter((r) => String(r.payload_json).includes(runId)).length;
}

before(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'arena-stop-finalize-'));
  outputs = path.join(tmp, 'outputs');
  process.env.ARENA_DB_PATH = path.join(tmp, 'test.db');
  process.env.OUTPUT_ROOT = outputs;
  process.env.AI_ARENA_ROOT = tmp;
  process.env.DB_DRIVER = 'sqlite';
  process.env.QUEUE_DRIVER = 'memory';
  initDb(process.env.ARENA_DB_PATH);
});

after(() => {
  delete process.env.ARENA_DB_PATH;
  delete process.env.OUTPUT_ROOT;
  delete process.env.AI_ARENA_ROOT;
  closeDb();
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('watcher holds a stopped run while the runner cancel signal is live', async () => {
  const runId = 'stop-held';
  await seedRun(runId);
  await markRunCancelled(runId);

  assert.equal(
    await attemptFinalizeCandidate((await getRunRecord(runId))!, logger),
    false,
    'a stopped run still owned by its runner must not be finalized',
  );
  assert.equal((await getRunRecord(runId))?.status, 'stopped', 'run stays stopped');
  assert.equal(ledgerRows(runId).length, 0, 'no ledger row before the runner finishes');
  assert.equal(notificationCount(runId), 0, 'no completion notification before the runner finishes');
});

test('watcher finalizes exactly once with the runner ledger once the signal is cleared', async () => {
  const runId = 'stop-cleared';
  await seedRun(runId);
  await markRunCancelled(runId);
  assert.equal(await attemptFinalizeCandidate((await getRunRecord(runId))!, logger), false);

  // The runner wrote result.json + the terminal 'stopped' row, then cleared
  // the signal as its acknowledgement that teardown is complete.
  writeResultFile(runId, 0.02);
  await clearRunCancelled(runId);

  assert.equal(await attemptFinalizeCandidate((await getRunRecord(runId))!, logger), true);
  assert.equal((await getRunRecord(runId))?.status, 'completed');
  const rows = ledgerRows(runId);
  assert.equal(rows.length, 1, 'exactly one ledger row');
  assert.ok(Math.abs(rows[0]!.cost_usd - 0.02) < 1e-9, 'ledger records the runner-written actual cost');

  assert.equal(
    await attemptFinalizeCandidate((await getRunRecord(runId))!, logger),
    false,
    'a second tick loses the finalization claim',
  );
  assert.equal(ledgerRows(runId).length, 1, 'no duplicate ledger row');
});

test('watcher finalizes a dead runner stop once the grace window elapses', async () => {
  const runId = 'stop-grace';
  // The runner died without clearing the signal: only the stop age can tell
  // the watcher the run is no longer owned.
  await seedRun(runId, { finishedAt: new Date(Date.now() - 11 * 60_000).toISOString() });
  await markRunCancelled(runId);
  writeResultFile(runId, 0.03);

  assert.equal(await attemptFinalizeCandidate((await getRunRecord(runId))!, logger), true, 'grace admits the dead runner');
  assert.equal((await getRunRecord(runId))?.status, 'completed');
  assert.equal(ledgerRows(runId).length, 1);
});

test('stopRun leaves a claimed row to its runner and the run finalizes after the ack', async () => {
  const runId = 'stop-claimed';
  await seedRun(runId, { runStatus: 'running', finishedAt: null, modelStatus: 'claimed' });

  await stopRun(runId);

  let held = (await getRunRecord(runId))!;
  assert.equal(held.status, 'stopped', 'stop marks the run stopped');
  assert.equal(held.perModel[0]!.status, 'claimed', 'stopRun must not force-terminalize the claimed row');
  assert.equal(
    await attemptFinalizeCandidate(held, logger),
    false,
    'the non-terminal row holds finalization until its runner acks',
  );

  // Runner ack: the claimed task observes cancellation, writes its own row,
  // then (as the last model) clears the signal.
  await transitionTaskState(runId, 'alpha', 'stopped');
  writeResultFile(runId, 0.04);
  await clearRunCancelled(runId);
  held = (await getRunRecord(runId))!;
  assert.equal(await attemptFinalizeCandidate(held, logger), true);
  assert.equal((await getRunRecord(runId))?.status, 'completed');
  assert.equal(ledgerRows(runId).length, 1);
});

test('watcher holds a stopped run while a sibling model row is non-terminal even with the signal cleared', async () => {
  const runId = 'stop-multi-hold';
  await seedModels(runId, [
    { model: 'alpha', status: 'stopped' },
    { model: 'beta', status: 'running' },
  ]);
  writeResultFile(runId, 0.02, 'alpha');
  await clearRunCancelled(runId);

  assert.equal(
    await attemptFinalizeCandidate((await getRunRecord(runId))!, logger),
    false,
    'a non-terminal sibling row must block finalization even when the signal is gone',
  );
  assert.equal((await getRunRecord(runId))?.status, 'stopped', 'run stays stopped');
  assert.equal(ledgerRows(runId).length, 0, 'no ledger row while a sibling is still executing');

  // The sibling's runner observes the stop, writes its own row, and clears the
  // signal as the last ack.
  writeResultFile(runId, 0.03, 'beta');
  await transitionTaskState(runId, 'beta', 'stopped');
  await clearRunCancelled(runId);

  assert.equal(await attemptFinalizeCandidate((await getRunRecord(runId))!, logger), true);
  assert.equal((await getRunRecord(runId))?.status, 'completed');
  const rows = ledgerRows(runId);
  assert.equal(rows.length, 2, 'both models must reach the ledger');
  const costs = rows.map((r) => r.cost_usd).sort((a, b) => a - b);
  assert.ok(Math.abs(costs[0]! - 0.02) < 1e-9 && Math.abs(costs[1]! - 0.03) < 1e-9, 'ledger records both actual costs');

  assert.equal(
    await attemptFinalizeCandidate((await getRunRecord(runId))!, logger),
    false,
    'a second tick loses the finalization claim',
  );
  assert.equal(ledgerRows(runId).length, 2, 'no duplicate ledger rows');
});

test('watcher force-stops a stale non-terminal row and finalizes a dead-runner stop once', async () => {
  const runId = 'stop-grace-row';
  await seedModels(
    runId,
    [{ model: 'alpha', status: 'running' }],
    { finishedAt: new Date(Date.now() - 11 * 60_000).toISOString() },
  );
  writeResultFile(runId, 0.05, 'alpha');

  // Past the grace window with the signal absent the runner is presumed dead:
  // the stale row is force-stopped so the run can finalize.
  assert.equal(await prepareRunFinalization(runId), true, 'past grace the dead runner is recovered');
  assert.equal(
    (await getRunRecord(runId))?.perModel[0]?.status,
    'stopped',
    'the stale non-terminal row must be force-stopped',
  );

  assert.equal(await attemptFinalizeCandidate((await getRunRecord(runId))!, logger), true);
  assert.equal((await getRunRecord(runId))?.status, 'completed');
  assert.equal(ledgerRows(runId).length, 1, 'exactly one ledger row');
  assert.equal(await attemptFinalizeCandidate((await getRunRecord(runId))!, logger), false);
  assert.equal(ledgerRows(runId).length, 1, 'no duplicate ledger row');
});

test('watcher reaps a stale running run whose runner died and finalizes exactly once', async () => {
  const runId = 'stale-running-reap';
  await seedModels(runId, [{ model: 'alpha', status: 'running' }], {
    runStatus: 'running',
    finishedAt: null,
    startedAt: new Date(Date.now() - 7 * 60 * 60_000).toISOString(),
  });
  writeResultFile(runId, 0.06);

  const stale = (await getRunRecord(runId))!;
  assert.equal(
    await reconcileStaleRunningRun(stale, logger),
    true,
    'a stale running run with no cancel signal is reconciled',
  );
  assert.equal(
    (await getRunRecord(runId))?.perModel[0]?.status,
    'failed',
    'the dead runner model row must be marked failed, not stopped',
  );
  assert.equal((await getRunRecord(runId))?.status, 'running', 'reconciliation itself does not finalize');

  assert.equal(
    await attemptFinalizeCandidate((await getRunRecord(runId))!, logger),
    true,
    'the normal gated finalization proceeds after the rows are terminal',
  );
  assert.equal((await getRunRecord(runId))?.status, 'completed');
  assert.equal(ledgerRows(runId).length, 1, 'exactly one ledger row');

  assert.equal(
    await attemptFinalizeCandidate((await getRunRecord(runId))!, logger),
    false,
    'a second tick loses the finalization claim',
  );
  assert.equal(ledgerRows(runId).length, 1, 'no duplicate ledger row');
});

test('watcher reaps a stale running run through attemptFinalizeCandidate alone', async () => {
  const runId = 'stale-running-watcher-path';
  await seedModels(runId, [{ model: 'alpha', status: 'running' }], {
    runStatus: 'running',
    finishedAt: null,
    startedAt: new Date(Date.now() - 7 * 60 * 60_000).toISOString(),
  });
  writeResultFile(runId, 0.02);

  assert.equal(
    await attemptFinalizeCandidate((await getRunRecord(runId))!, logger),
    true,
    'the watcher tick itself must reap the stale run and finalize it',
  );
  assert.equal((await getRunRecord(runId))?.status, 'completed');
  assert.equal(ledgerRows(runId).length, 1, 'exactly one ledger row');
  assert.equal(
    await attemptFinalizeCandidate((await getRunRecord(runId))!, logger),
    false,
    'a second tick loses the finalization claim',
  );
  assert.equal(ledgerRows(runId).length, 1, 'no duplicate ledger row');
});

test('a reaped run with no result.json finalizes as errored, never as success', async () => {
  const runId = 'stale-running-no-result';
  await seedModels(runId, [{ model: 'alpha', status: 'running' }], {
    runStatus: 'running',
    finishedAt: null,
    startedAt: new Date(Date.now() - 7 * 60 * 60_000).toISOString(),
  });

  assert.equal(
    await attemptFinalizeCandidate((await getRunRecord(runId))!, logger),
    true,
    'the watcher reaps and finalizes the dead-runner run',
  );

  const rec = await getRunRecord(runId);
  assert.notEqual(rec?.perModel[0]?.status, 'completed', 'a model with no result.json must not be marked completed');
  assert.equal(rec?.status, 'errored', 'a dead runner run with no model result must not finalize as completed');
  assert.equal(
    await attemptFinalizeCandidate(rec!, logger),
    false,
    'an errored run must not be finalized a second time',
  );
});

test('a fresh running run is not reaped', async () => {
  const runId = 'fresh-running';
  await seedModels(runId, [{ model: 'alpha', status: 'running' }], {
    runStatus: 'running',
    finishedAt: null,
    startedAt: new Date().toISOString(),
  });

  assert.equal(
    await attemptFinalizeCandidate((await getRunRecord(runId))!, logger),
    false,
    'a fresh running run with a non-terminal row is not finalizable',
  );
  assert.equal((await getRunRecord(runId))?.perModel[0]?.status, 'running', 'the fresh row is untouched');
  assert.equal((await getRunRecord(runId))?.status, 'running', 'the fresh run stays running');
  assert.equal(ledgerRows(runId).length, 0, 'no ledger row for a fresh run');
});

test('a stale running run with a live cancel signal is not reaped', async () => {
  const runId = 'stale-running-cancelled';
  await seedModels(runId, [{ model: 'alpha', status: 'running' }], {
    runStatus: 'running',
    finishedAt: null,
    startedAt: new Date(Date.now() - 7 * 60 * 60_000).toISOString(),
  });
  await markRunCancelled(runId);

  assert.equal(
    await attemptFinalizeCandidate((await getRunRecord(runId))!, logger),
    false,
    'a live cancel signal keeps the run owned by its runner',
  );
  assert.equal((await getRunRecord(runId))?.perModel[0]?.status, 'running', 'the row is untouched');
  assert.equal((await getRunRecord(runId))?.status, 'running', 'the run stays running');
});

test('RUN_STALE_AFTER_MS raises the reap threshold', async () => {
  const runId = 'stale-threshold-override';
  await seedModels(runId, [{ model: 'alpha', status: 'running' }], {
    runStatus: 'running',
    finishedAt: null,
    startedAt: new Date(Date.now() - 7 * 60 * 60_000).toISOString(),
  });
  const prior = process.env.RUN_STALE_AFTER_MS;
  process.env.RUN_STALE_AFTER_MS = String(8 * 60 * 60_000);
  try {
    assert.equal(
      await reconcileStaleRunningRun((await getRunRecord(runId))!, logger),
      false,
      'a 7h run is fresh under an 8h threshold',
    );
    assert.equal((await getRunRecord(runId))?.perModel[0]?.status, 'running', 'the row is untouched');
  } finally {
    if (prior === undefined) delete process.env.RUN_STALE_AFTER_MS;
    else process.env.RUN_STALE_AFTER_MS = prior;
  }
});
