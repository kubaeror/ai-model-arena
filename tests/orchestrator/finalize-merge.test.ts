import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { initDb, closeDb, getDb, getDrizzleDb } from '../../src/db/index.js';
import { resetBudgetCache, loadBudgetConfig, getBudgetStatus } from '../../src/cost-tracking/budget.js';
import { cost_ledger, notifications } from '../../src/db/schema.js';
import { eq } from 'drizzle-orm';
import { createLogger } from '../../src/logger/pino-logger.js';
import {
  finalizeRun,
  finalizeRunByRunId,
  registerRun,
  isRunComplete,
  isRunCompleteByRunId,
  isRunCancelled,
  stopRun,
  type RunSpec,
  type PerModelSpec,
} from '../../src/orchestrator/run-lifecycle.js';
import { claimRunFinalization } from '../../src/orchestrator/finalize/aggregate.js';
import { getRunRecord, updateRun, upsertRun } from '../../src/orchestrator/run-index.js';
import { writeJudgeResult } from '../../src/evaluation/judge.js';

async function countRunNotifications(runId: string): Promise<number> {
  const db = getDrizzleDb();
  const rows = await db.select().from(notifications).all();
  return rows.filter((r: Record<string, unknown>) => String(r.payload_json ?? '').includes(runId)).length;
}

async function waitForRunNotifications(runId: string, expected: number, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if ((await countRunNotifications(runId)) >= expected) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  assert.fail(`expected ${expected} notification(s) for ${runId}`);
}

function makePerModel(runId: string, model: string, root: string, _ts: string): PerModelSpec {
  const outputDir = path.join(root, 'outputs', model, runId);
  return {
    model,
    providerId: 'test',
    outputDir,
    sandboxDir: path.join(outputDir, 'files'),
    resultPath: path.join(outputDir, 'result.json'),
    conversationPath: path.join(outputDir, 'conversation.json'),
    reportPath: path.join(outputDir, 'report.md'),
    logFile: path.join(outputDir, 'pm2.log'),
  };
}

function writeResult(spec: PerModelSpec, overrides: Record<string, unknown> = {}): void {
  fs.mkdirSync(spec.outputDir, { recursive: true });
  fs.mkdirSync(spec.sandboxDir, { recursive: true });
  const result = {
    model: spec.model,
    scenario: 'basic',
    runId: path.basename(spec.outputDir),
    success: true,
    maxTurns: 5,
    turnsUsed: 2,
    totalToolCalls: 3,
    toolsCalled: [{ name: 'read_file', count: 3 }],
    tokenUsage: { prompt: 100, completion: 50, total: 150 },
    stopReason: 'completed',
    durationMs: 1234,
    errors: [],
    costUsd: 0.02,
    successCriteria: { command: 'echo ok', expectedExitCode: 0, exitCode: 0, passed: true },
    ...overrides,
  };
  fs.writeFileSync(spec.resultPath, JSON.stringify(result, null, 2));
}

function buildSpec(runId: string, root: string, models: PerModelSpec[]): RunSpec {
  return {
    runId,
    scenario: 'basic',
    ts: runId,
    startedAt: new Date().toISOString(),
    root,
    modelsConfigPath: path.join(root, 'configs', 'models.yaml'),
    scenariosDir: path.join(root, 'configs', 'scenarios'),
    comparisonBase: path.join(root, 'outputs', 'comparisons', runId),
    models,
  };
}

describe('finalize merge (run-lifecycle single core)', () => {
  let tmp: string;
  let root: string;
  let logger: ReturnType<typeof createLogger>;
  let notifyServer: http.Server;

  before(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'arena-finalize-'));
    root = tmp;
    process.env.ARENA_DB_PATH = path.join(tmp, 'arena.db');
    process.env.OUTPUT_ROOT = path.join(tmp, 'outputs');
    process.env.AI_ARENA_ROOT = tmp;
    initDb(path.join(tmp, 'arena.db'));
    resetBudgetCache();
    logger = createLogger('test:finalize', 'warn');

    // Local sink for the completion notification so finalize's fire-and-forget
    // dispatch persists exactly one outbox row per successful claim, without
    // network retries. Must be configured before the first finalize in this
    // file (loadNotificationConfig caches process-wide).
    notifyServer = http.createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('ok');
    });
    await new Promise<void>((resolve) => notifyServer.listen(0, '127.0.0.1', resolve));
    const notifyPort = (notifyServer.address() as AddressInfo).port;
    fs.mkdirSync(path.join(root, 'configs'), { recursive: true });
    fs.writeFileSync(path.join(root, 'configs', 'notifications.yaml'), [
      'channels:',
      '  test-channel:',
      '    type: slack',
      `    webhookUrl: http://127.0.0.1:${notifyPort}/hook`,
      'routing:',
      '  onRunCompleted:',
      '    - test-channel',
      '',
    ].join('\n'));
  });

  after(async () => {
    await new Promise((resolve) => setTimeout(resolve, 50));
    await new Promise<void>((resolve) => {
      notifyServer.close(() => resolve());
      notifyServer.closeAllConnections();
    });
    delete process.env.ARENA_DB_PATH;
    delete process.env.OUTPUT_ROOT;
    delete process.env.AI_ARENA_ROOT;
    await closeDb();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('finalizeRun returns entries/md/json and patches index to completed (success)', async () => {
    const runId = 'run_merge_success';
    const alpha = makePerModel(runId, 'alpha', root, 't1');
    const beta = makePerModel(runId, 'beta', root, 't1');
    writeResult(alpha);
    writeResult(beta);
    const spec = buildSpec(runId, root, [alpha, beta]);
    await registerRun(spec, 'cli');

    const out = await finalizeRun(spec, logger);

    assert.strictEqual(out.entries.length, 2);
    assert.ok(out.mdPath.endsWith('.md') && fs.existsSync(out.mdPath), 'comparison.md written');
    assert.ok(out.jsonPath.endsWith('.json') && fs.existsSync(out.jsonPath), 'comparison.json written');
    assert.ok(out.entries.every((e) => e.result), 'every model parsed a result');

    const rec = await getRunRecord(runId);
    assert.ok(rec, 'run record exists');
    assert.strictEqual(rec.status, 'completed');
    assert.strictEqual(rec.comparisonMdPath, out.mdPath);
    assert.ok(rec.perModel.every((m) => m.status === 'completed'), 'per-model marked completed');
    assert.ok(rec.perModel.every((m) => m.success === true), 'per-model success persisted');
  });

  it('finalizeRunByRunId resolves the same core path via the index', async () => {
    const runId = 'run_merge_hookup';
    const alpha = makePerModel(runId, 'alpha', root, 't2');
    writeResult(alpha, { success: false, costUsd: 0.0 });
    const spec = buildSpec(runId, root, [alpha]);
    await registerRun(spec, 'dashboard');

    await assert.doesNotReject(finalizeRunByRunId(runId, logger));

    const rec = await getRunRecord(runId);
    assert.ok(rec, 'run record exists');
    assert.strictEqual(rec.status, 'completed');
    assert.strictEqual(rec.perModel[0]!.status, 'completed');
    assert.strictEqual(rec.perModel[0]!.success, false);
  });

  it('errored per-model is surfaced (missing result.json) without throwing', async () => {
    const runId = 'run_merge_errored';
    const alpha = makePerModel(runId, 'alpha', root, 't3');
    const beta = makePerModel(runId, 'beta', root, 't3');
    writeResult(alpha);
    fs.mkdirSync(beta.outputDir, { recursive: true });
    const spec = buildSpec(runId, root, [alpha, beta]);
    await registerRun(spec, 'cli');

    const out = await finalizeRun(spec, logger);

    const betaEntry = out.entries.find((e) => e.model === 'beta');
    assert.ok(betaEntry?.error, 'missing result surfaces an error entry');
    const rec = await getRunRecord(runId);
    assert.strictEqual(rec?.perModel.find((m) => m.model === 'beta')?.status, 'errored');
    assert.strictEqual(rec?.perModel.find((m) => m.model === 'alpha')?.status, 'completed');
  });

  it('finalizeRunByRunId on a missing run returns false without throwing', async () => {
    const res = await finalizeRunByRunId('run_does_not_exist', logger);
    assert.strictEqual(res, false);
  });

  it('merged finalize with costUsd>0 writes one cost_ledger row and credits budget spend once', async () => {
    const cfgDir = path.join(root, 'configs');
    fs.mkdirSync(cfgDir, { recursive: true });
    fs.writeFileSync(path.join(cfgDir, 'budget.yaml'), [
      'global:',
      '  daily: 1000',
      '  monthly: 1000',
      'models:',
      '  alpha:',
      '    daily: 100',
      '    monthly: 100',
      'stateFile: outputs/.budget-state.json',
      '',
    ].join('\n'));
    resetBudgetCache();
    loadBudgetConfig(path.join(cfgDir, 'budget.yaml'), logger);

    const runId = 'run_ledger_single_credit';
    const alpha = makePerModel(runId, 'alpha', root, 't-ledger');
    writeResult(alpha, { costUsd: 0.02 });
    const spec = buildSpec(runId, root, [alpha]);
    await registerRun(spec, 'dashboard');

    await finalizeRun(spec, logger);

    const db = getDrizzleDb();
    const ledger = await db.select().from(cost_ledger).where(eq(cost_ledger.run_id, runId));
    assert.strictEqual(ledger.length, 1, 'exactly one cost_ledger row for this run');
    assert.ok(Math.abs(Number(ledger[0].cost_usd) - 0.02) < 1e-9, 'ledger cost recorded as 0.02');
    assert.strictEqual(Number(ledger[0].total_tokens), 150, 'ledger tokens recorded from result.json');

    await new Promise((resolve) => setTimeout(resolve, 50));
    const status = getBudgetStatus(root, logger);
    assert.strictEqual(status.models.alpha!.daily.spent, 0.02, 'budget daily spend credited once (0.02, not 0.04)');
    assert.strictEqual(status.global.daily.spent, 0.02, 'global budget daily spend credited once');
  });

  it('concurrent double finalize is idempotent: one ledger row, one notification, stable finishedAt', async () => {
    const runId = 'run_double_finalize';
    const alpha = makePerModel(runId, 'alpha', root, 't-double');
    writeResult(alpha, { costUsd: 0.03 });
    const spec = buildSpec(runId, root, [alpha]);
    await registerRun(spec, 'dashboard');

    await Promise.all([
      finalizeRunByRunId(runId, logger),
      finalizeRunByRunId(runId, logger),
    ]);

    const db = getDrizzleDb();
    const ledger = await db.select().from(cost_ledger).where(eq(cost_ledger.run_id, runId));
    assert.strictEqual(ledger.length, 1, 'exactly one cost_ledger row despite concurrent finalize');

    const first = await getRunRecord(runId);
    assert.strictEqual(first?.status, 'completed');
    assert.ok(first?.finishedAt, 'finalize stamps finishedAt');
    const firstFinishedAt = first!.finishedAt;

    await waitForRunNotifications(runId, 1);

    const second = await finalizeRunByRunId(runId, logger);
    assert.strictEqual(second, false, 're-finalize loses the atomic claim');
    await new Promise((resolve) => setTimeout(resolve, 100));

    const rec = await getRunRecord(runId);
    assert.strictEqual(rec?.status, 'completed');
    assert.strictEqual(rec?.finishedAt, firstFinishedAt, 'finishedAt must not change on re-finalize');
    assert.strictEqual(await countRunNotifications(runId), 1, 'exactly one run_completed notification');
  });

  it('a stopped run with all models terminal finalizes exactly once through the claim', async () => {
    const runId = 'run_stopped_claim';
    const alpha = makePerModel(runId, 'alpha', root, 't-stopped');
    writeResult(alpha, { costUsd: 0.04 });
    await upsertRun({
      runId, scenario: 'basic', models: ['alpha'],
      startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(),
      status: 'stopped', source: 'dashboard',
      perModel: [{
        model: 'alpha', runId, outputDir: alpha.outputDir, sandboxDir: alpha.sandboxDir,
        resultPath: alpha.resultPath, conversationPath: alpha.conversationPath,
        reportPath: alpha.reportPath, logFile: alpha.logFile, status: 'stopped',
      } as never],
      comparisonMdPath: null, comparisonJsonPath: null,
    });

    assert.strictEqual(await isRunCompleteByRunId(runId), true, 'stopped models are terminal');
    await finalizeRunByRunId(runId, logger);

    const rec = await getRunRecord(runId);
    assert.strictEqual(rec?.status, 'completed');
    const db = getDrizzleDb();
    const ledger = await db.select().from(cost_ledger).where(eq(cost_ledger.run_id, runId));
    assert.strictEqual(ledger.length, 1, 'exactly one cost_ledger row for the stopped run');

    assert.strictEqual(await finalizeRunByRunId(runId, logger), false, 'second finalize loses the claim');
  });

  it('a throw after the claim leaves the run finalizing; a stale retry completes exactly once', async () => {
    const runId = 'run_finalize_recovery';
    const alpha = makePerModel(runId, 'alpha', root, 't-recovery');
    writeResult(alpha, { costUsd: 0.05 });
    const spec = buildSpec(runId, root, [alpha]);
    await registerRun(spec, 'cli');

    // Force the aggregation write to throw: comparisons/ exists as a file, so
    // writeComparison's mkdir fails after the claim has been taken.
    const comparisonsDir = path.join(root, 'outputs', 'comparisons');
    fs.rmSync(comparisonsDir, { recursive: true, force: true });
    fs.writeFileSync(comparisonsDir, 'not a directory');
    try {
      await assert.rejects(finalizeRun(spec, logger), 'aggregation failure must propagate, not be swallowed');
    } finally {
      fs.rmSync(comparisonsDir, { force: true });
    }

    let rec = await getRunRecord(runId);
    assert.strictEqual(rec?.status, 'finalizing', 'a failed finalize leaves the run reclaimable, not completed');
    assert.ok(rec?.finishedAt, 'the claim stamps finishedAt');

    // A young claim is held by the (possibly still alive) original finalizer.
    assert.strictEqual(await claimRunFinalization(runId), false, 'a fresh finalizing claim must not be stolen');

    // Age the claim past the stale window, as the watcher does for a crashed finalizer.
    await updateRun(runId, (r) => { r.finishedAt = new Date(Date.now() - 3 * 60_000).toISOString(); });
    assert.strictEqual(await finalizeRunByRunId(runId, logger), true, 'stale finalizing run is reclaimed');

    rec = await getRunRecord(runId);
    assert.strictEqual(rec?.status, 'completed');
    const db = getDrizzleDb();
    const ledger = await db.select().from(cost_ledger).where(eq(cost_ledger.run_id, runId));
    assert.strictEqual(ledger.length, 1, 'exactly one ledger row after recovery');
    await waitForRunNotifications(runId, 1);
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.strictEqual(await countRunNotifications(runId), 1, 'exactly one notification after recovery');
  });

  it('stopRun during finalization is a no-op and cannot trigger a second finalization', async () => {
    const runId = 'run_stop_during_finalize';
    const alpha = makePerModel(runId, 'alpha', root, 't-stop-fin');
    writeResult(alpha, { costUsd: 0.06 });
    const spec = buildSpec(runId, root, [alpha]);
    await registerRun(spec, 'dashboard');

    assert.strictEqual(await claimRunFinalization(runId), true);
    const claimedAt = (await getRunRecord(runId))?.finishedAt;

    await stopRun(runId);

    let rec = await getRunRecord(runId);
    assert.strictEqual(rec?.status, 'finalizing', 'stop must not regress a finalizing run');
    assert.strictEqual(rec?.finishedAt, claimedAt, 'no-op stop must not move finishedAt');
    assert.strictEqual(await isRunCancelled(runId), false, 'no-op stop must not record a cancellation signal');

    await updateRun(runId, (r) => { r.finishedAt = new Date(Date.now() - 3 * 60_000).toISOString(); });
    assert.strictEqual(await finalizeRunByRunId(runId, logger), true);
    rec = await getRunRecord(runId);
    assert.strictEqual(rec?.status, 'completed');

    await stopRun(runId);
    rec = await getRunRecord(runId);
    assert.strictEqual(rec?.status, 'completed', 'stop after completion stays a no-op');
    assert.strictEqual(await finalizeRunByRunId(runId, logger), false, 'no second finalization');

    const db = getDrizzleDb();
    const ledger = await db.select().from(cost_ledger).where(eq(cost_ledger.run_id, runId));
    assert.strictEqual(ledger.length, 1, 'exactly one ledger row');
  });

  it('concurrent stop and finalize settle on exactly one completed finalization', async () => {
    const runId = 'run_stop_race_finalize';
    const alpha = makePerModel(runId, 'alpha', root, 't-stop-race');
    writeResult(alpha, { costUsd: 0.07 });
    const spec = buildSpec(runId, root, [alpha]);
    await registerRun(spec, 'dashboard');

    await Promise.all([stopRun(runId), finalizeRunByRunId(runId, logger)]);

    const rec = await getRunRecord(runId);
    assert.strictEqual(rec?.status, 'completed', 'the race must settle on a completed finalization');
    assert.strictEqual(await finalizeRunByRunId(runId, logger), false, 're-finalize loses the claim');

    const db = getDrizzleDb();
    const ledger = await db.select().from(cost_ledger).where(eq(cost_ledger.run_id, runId));
    assert.strictEqual(ledger.length, 1, 'exactly one ledger row');
  });

  it('judge_score.json is NOT written when judge is disabled', async () => {
    const cfgDir = path.join(root, 'configs');
    fs.mkdirSync(cfgDir, { recursive: true });
    fs.writeFileSync(path.join(cfgDir, 'evaluation.yaml'), [
      'judge:',
      '  model: gpt-4o',
      '  enabled: false',
      'rubric:',
      '  correctness:',
      '    description: "code correctness"',
      '    maxScore: 10',
      '',
    ].join('\n'));

    const runId = 'run_judge_disabled';
    const alpha = makePerModel(runId, 'alpha', root, 't-judge');
    writeResult(alpha, { costUsd: 0.01 });
    const spec = buildSpec(runId, root, [alpha]);
    await registerRun(spec, 'cli');

    await finalizeRun(spec, logger);

    const judgeFile = path.join(alpha.outputDir, 'judge_score.json');
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.strictEqual(fs.existsSync(judgeFile), false, 'judge_score.json not written when judge disabled');
  });

  it('finalizeCore judge step persists a judge_scores row for each judged model (single persistence site)', async () => {
    const cfgDir = path.join(root, 'configs');
    fs.mkdirSync(cfgDir, { recursive: true });
    fs.writeFileSync(path.join(cfgDir, 'evaluation.yaml'), [
      'judge:',
      '  model: gpt-4o',
      '  enabled: true',
      'rubric:',
      '  correctness:',
      '    description: "code correctness"',
      '    maxScore: 10',
      '',
    ].join('\n'));

    const now = new Date().toISOString();
    const dbRaw = getDb();
    dbRaw.prepare(
      `INSERT INTO providers (id, name, api_base, auth_scheme, is_builtin, adapter, created_at, updated_at)
       VALUES ('openai', 'OpenAI', 'https://api.openai.com/v1', 'bearer', 1, 'openai-compat', ?, ?)`,
    ).run(now, now);
    dbRaw.prepare(
      `INSERT INTO models (id, name, provider_id, status, last_synced_at)
       VALUES ('gpt-4o', 'GPT-4o', 'openai', 'active', ?)`,
    ).run(now);
    dbRaw.prepare(
      `INSERT INTO model_providers (model_id, provider_id, api_model_id)
       VALUES ('gpt-4o', 'openai', 'gpt-4o')`,
    ).run();

    const judgeAdapter = {
      sendMessage: async () => ({
        text: JSON.stringify({ scores: [{ category: 'correctness', score: 8, maxScore: 10 }], summary: 'ok' }),
        usage: {},
        toolCalls: [],
      }),
      supportsReasoning: () => false,
      supportsPromptCaching: () => false,
    };

    const runId = 'run_judge_enabled';
    const alpha = makePerModel(runId, 'alpha', root, 't-judge-on');
    writeResult(alpha, { costUsd: 0.01 });
    const spec = buildSpec(runId, root, [alpha]);
    await registerRun(spec, 'cli');

    await finalizeRun(spec, logger, judgeAdapter);

    const deadline = Date.now() + 2000;
    let row: any = null;
    while (Date.now() < deadline) {
      row = dbRaw.prepare('SELECT * FROM judge_scores WHERE run_id = ? AND model = ?').get(runId, 'alpha');
      if (row) break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }

    assert.ok(row, 'judge step persists a judge_scores row for the model');
    assert.equal(row.judge_model, 'gpt-4o');
    assert.equal(row.average_score, 8);
    assert.equal(row.summary, 'ok');
    assert.ok(row.scores_json.includes('correctness'));
    const count = (dbRaw.prepare('SELECT COUNT(*) AS c FROM judge_scores WHERE run_id = ? AND model = ?').get(runId, 'alpha') as any).c;
    assert.equal(count, 1, 'exactly one judge_scores row per run+model');
  });

  it('writeJudgeResult persists judge_score.json (the finalizeCore persist step)', () => {
    const outputDir = path.join(tmp, 'judge-out');
    const verdict = {
      model: 'alpha',
      runId: 'run_judge_unit',
      scores: [{ category: 'correctness', score: 9, maxScore: 10, reasoning: 'ok' }],
      averageScore: 90,
      summary: 'solid',
      judgedAt: new Date().toISOString(),
      judgeModel: 'test-judge',
    };
    writeJudgeResult(outputDir, verdict, logger);
    const file = path.join(outputDir, 'judge_score.json');
    assert.ok(fs.existsSync(file), 'judge_score.json written');
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.strictEqual(parsed.model, 'alpha');
    assert.strictEqual(parsed.averageScore, 90);
  });

  it('isRunComplete is false when the run record is absent (registration failure)', async () => {
    const runId = 'run_absent';
    const alpha = makePerModel(runId, 'alpha', root, 't-absent');
    const spec = buildSpec(runId, root, [alpha]);
    assert.strictEqual(await isRunComplete(spec), false);
  });

  it('isRunComplete is false while a model is running or claimed', async () => {
    const runId = 'run_inflight';
    const alpha = makePerModel(runId, 'alpha', root, 't-inflight');
    const spec = buildSpec(runId, root, [alpha]);
    await registerRun(spec, 'cli');
    assert.strictEqual(await isRunComplete(spec), false, 'running is not complete');
    await updateRun(runId, (r) => { r.perModel[0]!.status = 'running'; });
    assert.strictEqual(await isRunComplete(spec), false, 'non-terminal status is not complete');
  });

  it('isRunComplete is true when every model reached a terminal status', async () => {
    const runId = 'run_terminal';
    const alpha = makePerModel(runId, 'alpha', root, 't-terminal');
    const beta = makePerModel(runId, 'beta', root, 't-terminal');
    const spec = buildSpec(runId, root, [alpha, beta]);
    await registerRun(spec, 'cli');
    await updateRun(runId, (r) => {
      r.perModel.find((m) => m.model === 'alpha')!.status = 'completed';
      r.perModel.find((m) => m.model === 'beta')!.status = 'errored';
    });
    assert.strictEqual(await isRunComplete(spec), true);
  });

  it('isRunCompleteByRunId is false when the run record is absent', async () => {
    assert.strictEqual(await isRunCompleteByRunId('run_absent_by_id'), false);
  });

  it('isRunCompleteByRunId is false while a model is running or claimed', async () => {
    const runId = 'run_inflight_by_id';
    const alpha = makePerModel(runId, 'alpha', root, 't-byid');
    const spec = buildSpec(runId, root, [alpha]);
    await registerRun(spec, 'cli');
    assert.strictEqual(await isRunCompleteByRunId(runId), false, 'running is not complete');
    await updateRun(runId, (r) => { r.perModel[0]!.status = 'running'; });
    assert.strictEqual(await isRunCompleteByRunId(runId), false, 'non-terminal status is not complete');
  });

  it('isRunCompleteByRunId is false when any model has an unknown status', async () => {
    const runId = 'run_unknown_by_id';
    const alpha = makePerModel(runId, 'alpha', root, 't-byid');
    const spec = buildSpec(runId, root, [alpha]);
    await registerRun(spec, 'cli');
    await updateRun(runId, (r) => { r.perModel[0]!.status = 'unknown'; });
    assert.strictEqual(await isRunCompleteByRunId(runId), false, 'unknown is not complete');
  });

  it('isRunCompleteByRunId is true when every model reached a terminal status', async () => {
    const runId = 'run_terminal_by_id';
    const alpha = makePerModel(runId, 'alpha', root, 't-byid');
    const beta = makePerModel(runId, 'beta', root, 't-byid');
    const spec = buildSpec(runId, root, [alpha, beta]);
    await registerRun(spec, 'cli');
    await updateRun(runId, (r) => {
      r.perModel.find((m) => m.model === 'alpha')!.status = 'completed';
      r.perModel.find((m) => m.model === 'beta')!.status = 'errored';
    });
    assert.strictEqual(await isRunCompleteByRunId(runId), true);
  });
});
