import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { initDb, closeDb, getDb, getDrizzleDb } from '../../src/db/index.js';
import { resetBudgetCache, loadBudgetConfig, getBudgetStatus } from '../../src/cost-tracking/budget.js';
import { cost_ledger } from '../../src/db/schema.js';
import { eq } from 'drizzle-orm';
import { createLogger } from '../../src/logger/pino-logger.js';
import {
  finalizeRun,
  finalizeRunByRunId,
  registerRun,
  isRunComplete,
  type RunSpec,
  type PerModelSpec,
} from '../../src/orchestrator/run-lifecycle.js';
import { getRunRecord, updateRun } from '../../src/orchestrator/run-index.js';
import { writeJudgeResult } from '../../src/evaluation/judge.js';

function makePerModel(runId: string, model: string, root: string, ts: string): PerModelSpec {
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

  before(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'arena-finalize-'));
    root = tmp;
    process.env.ARENA_DB_PATH = path.join(tmp, 'arena.db');
    process.env.OUTPUT_ROOT = path.join(tmp, 'outputs');
    process.env.AI_ARENA_ROOT = tmp;
    initDb(path.join(tmp, 'arena.db'));
    resetBudgetCache();
    logger = createLogger('test:finalize', 'warn');
  });

  after(async () => {
    await new Promise((resolve) => setTimeout(resolve, 50));
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
    assert.strictEqual(rec.perModel[0].status, 'completed');
    assert.strictEqual(rec.perModel[0].success, false);
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

  it('finalizeRunByRunId on a missing run returns undefined without throwing', async () => {
    const res = await finalizeRunByRunId('run_does_not_exist', logger);
    assert.strictEqual(res, undefined);
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
    assert.strictEqual(status.models.alpha.daily.spent, 0.02, 'budget daily spend credited once (0.02, not 0.04)');
    assert.strictEqual(status.global.daily.spent, 0.02, 'global budget daily spend credited once');
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

  it('finalizeCore judge step persists a judge_scores row for each judged model (single persistence site)', async (t) => {
    if (typeof (t.mock as { module?: unknown }).module !== 'function') {
      t.skip('t.mock.module requires --experimental-test-module-mocks (provided by npm test)');
      return;
    }
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

    t.mock.module('../../src/providers/index.js', {
      exports: {
        ProviderRegistry: class {
          async loadCustomFromDb(): Promise<void> {}
          createAdapter(): { sendMessage: () => Promise<{ text: string }> } {
            return {
              sendMessage: async () => ({
                text: '```json\n{"scores": [{"category": "correctness", "score": 10, "maxScore": 10}], "summary": "Solid work"}\n```',
              }),
            };
          }
        },
        loadBuiltins(): void {},
      },
    });

    const runId = 'run_judge_enabled';
    const alpha = makePerModel(runId, 'alpha', root, 't-judge-on');
    writeResult(alpha, { costUsd: 0.01 });
    const spec = buildSpec(runId, root, [alpha]);
    await registerRun(spec, 'cli');

    await finalizeRun(spec, logger);

    const deadline = Date.now() + 2000;
    let row: any = null;
    while (Date.now() < deadline) {
      row = dbRaw.prepare('SELECT * FROM judge_scores WHERE run_id = ? AND model = ?').get(runId, 'alpha');
      if (row) break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }

    assert.ok(row, 'judge step persists a judge_scores row for the model');
    assert.equal(row.judge_model, 'gpt-4o');
    assert.equal(row.average_score, 10);
    assert.equal(row.summary, 'Solid work');
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
    await updateRun(runId, (r) => { r.perModel[0]!.status = 'claimed'; });
    assert.strictEqual(await isRunComplete(spec), false, 'claimed is not complete');
  });

  it('isRunComplete is true when every model reached a terminal status', async () => {
    const runId = 'run_terminal';
    const alpha = makePerModel(runId, 'alpha', root, 't-terminal');
    const beta = makePerModel(runId, 'beta', root, 't-terminal');
    const spec = buildSpec(runId, root, [alpha, beta]);
    await registerRun(spec, 'cli');
    await updateRun(runId, (r) => {
      r.perModel.find((m) => m.model === 'alpha')!.status = 'completed';
      r.perModel.find((m) => m.model === 'beta')!.status = 'failed';
    });
    assert.strictEqual(await isRunComplete(spec), true);
  });
});
