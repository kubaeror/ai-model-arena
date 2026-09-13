import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { initDb, closeDb, getDb } from '../../src/db/client.js';
import { upsertRun, getRunRecord } from '../../src/db/runs.js';
import { transitionTaskState } from '../../src/db/query.js';
import { attemptFinalizeCandidate } from '../../src/dashboard-server/live.js';
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
    startedAt: new Date().toISOString(),
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
