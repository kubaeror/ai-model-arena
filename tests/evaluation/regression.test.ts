import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import {
  createBaselineSnapshot,
  compareBaseline,
  runRegressionSuite,
  saveSuiteResult,
  listSavedSuiteResults,
} from '../../src/evaluation/regression.js';
import type { SuiteResult } from '../../src/evaluation/regression.js';
import type { RunResult } from '../../src/logger/result-logger.js';
import type { JudgeResult, BaselineSnapshot } from '../../src/evaluation/types.js';

function runResult(overrides: Partial<RunResult> = {}): RunResult {
  return {
    model: 'gpt-4o',
    scenario: 'scenario-a',
    runId: 'run-1',
    startedAt: '2026-01-01T00:00:00.000Z',
    finishedAt: '2026-01-01T00:00:01.000Z',
    durationMs: 1000,
    turnsUsed: 2,
    maxTurns: 10,
    totalToolCalls: 3,
    toolsCalled: [{ name: 'write_file', count: 3 }],
    tokenUsage: { prompt: 100, completion: 50 },
    errors: [],
    success: true,
    ...overrides,
  };
}

function judgeResult(overrides: Partial<JudgeResult> = {}): JudgeResult {
  return {
    model: 'gpt-4o',
    runId: 'run-1',
    scores: [{ category: 'correctness', score: 7, maxScore: 10 }],
    averageScore: 7,
    summary: 'ok',
    judgedAt: '2026-01-01T00:00:02.000Z',
    judgeModel: 'gpt-4o',
    ...overrides,
  };
}

const thresholds = { scoreDrop: 1.0, tokenIncrease: 0.5, timeIncrease: 0.5 };

test('createBaselineSnapshot returns null when judge result is absent', () => {
  const snap = createBaselineSnapshot(runResult(), null);
  assert.equal(snap, null);
});

test('createBaselineSnapshot records judge averageScore when present', () => {
  const snap = createBaselineSnapshot(runResult(), judgeResult({ averageScore: 7.5 }));
  assert.ok(snap);
  assert.equal((snap as BaselineSnapshot).metrics.averageScore, 7.5);
});

test('compareBaseline reports sane percentage increase for tiny baselines', () => {
  const current = runResult({ runId: 'run-2', tokenUsage: { prompt: 1, completion: 0 }, durationMs: 2000 });
  const baseline: BaselineSnapshot = {
    runId: 'run-1',
    model: 'gpt-4o',
    scenario: 'scenario-a',
    timestamp: '2026-01-01T00:00:00.000Z',
    metrics: { averageScore: 0.5, totalTokens: 0.5, durationMs: 1000, success: true },
  };
  const result = compareBaseline(current, baseline, judgeResult({ averageScore: 1.0 }), thresholds);

  const tokenRegression = result.regressions.find((r) => r.metric === 'totalTokens');
  assert.ok(tokenRegression, 'expected a totalTokens regression');
  assert.ok(Math.abs(tokenRegression!.change - 1.0) < 0.001, `expected +100%, got ${tokenRegression!.change}`);

  const timeRegression = result.regressions.find((r) => r.metric === 'durationMs');
  assert.ok(timeRegression, 'expected a durationMs regression');
  assert.ok(Math.abs(timeRegression!.change - 1.0) < 0.001, `expected +100%, got ${timeRegression!.change}`);
});

test('compareBaseline does not divide by zero for zero baselines', () => {
  const current = runResult({ runId: 'run-2', tokenUsage: { prompt: 100, completion: 50 } });
  const baseline: BaselineSnapshot = {
    runId: 'run-1',
    model: 'gpt-4o',
    scenario: 'scenario-a',
    timestamp: '2026-01-01T00:00:00.000Z',
    metrics: { averageScore: 7, totalTokens: 0, durationMs: 0, success: true },
  };
  const result = compareBaseline(current, baseline, judgeResult(), thresholds);
  assert.ok(result.regressions.every((r) => Number.isFinite(r.change)));
  assert.equal(result.regressions.find((r) => r.metric === 'totalTokens'), undefined);
});

test('runRegressionSuite generates a unique runId per call', async () => {
  const getCurrentRunResult = async () => null;
  const first = await runRegressionSuite('suite-a', [], [], '/tmp/baselines', thresholds, getCurrentRunResult);
  const second = await runRegressionSuite('suite-a', [], [], '/tmp/baselines', thresholds, getCurrentRunResult);
  assert.match(first.runId, /^regress-/);
  assert.match(second.runId, /^regress-/);
  assert.notEqual(first.runId, second.runId);
});

function sampleSuiteResult(): SuiteResult {
  return {
    suite: 'suite-a',
    runId: 'regress-1',
    model: 'gpt-4o',
    scenarioResults: [],
    passed: true,
    timestamp: '2026-01-01T00:00:00.000Z',
  };
}

function recordingLogger() {
  const warns: Array<{ msg: string; data?: unknown }> = [];
  const logger = {
    info: () => {},
    warn: (msg: string, data?: unknown) => { warns.push({ msg, data }); },
    error: () => {},
    debug: () => {},
    child: () => logger,
  };
  return { logger, warns };
}

test('saveSuiteResult does not throw when the results directory cannot be created', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'arena-regression-save-'));
  const prev = process.env.OUTPUT_ROOT;
  process.env.OUTPUT_ROOT = root;
  try {
    // A FILE at <root>/regression makes mkdirSync(<root>/regression/<suite>) throw ENOTDIR.
    fs.mkdirSync(path.join(root, 'regression'), { recursive: true });
    fs.writeFileSync(path.join(root, 'regression', 'suite-a'), '');
    const { logger, warns } = recordingLogger();
    assert.doesNotThrow(() => saveSuiteResult(sampleSuiteResult(), logger));
    assert.ok(warns.some((w) => w.msg.includes('Failed to save')), 'expected a warn log on save failure');
  } finally {
    if (prev === undefined) delete process.env.OUTPUT_ROOT;
    else process.env.OUTPUT_ROOT = prev;
  }
});

test('saveSuiteResult does not throw when writing the result file fails', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'arena-regression-save-'));
  const prev = process.env.OUTPUT_ROOT;
  process.env.OUTPUT_ROOT = root;
  try {
    // A DIRECTORY at the file path makes writeFileSync throw EISDIR.
    fs.mkdirSync(path.join(root, 'regression', 'suite-a', 'regression-results.json'), { recursive: true });
    const { logger, warns } = recordingLogger();
    assert.doesNotThrow(() => saveSuiteResult(sampleSuiteResult(), logger));
    assert.ok(warns.some((w) => w.msg.includes('Failed to save')), 'expected a warn log on save failure');
  } finally {
    if (prev === undefined) delete process.env.OUTPUT_ROOT;
    else process.env.OUTPUT_ROOT = prev;
  }
});

test('listSavedSuiteResults returns [] when the results root cannot be read', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'arena-regression-list-'));
  const prev = process.env.OUTPUT_ROOT;
  process.env.OUTPUT_ROOT = root;
  try {
    // A FILE at <root>/regression passes existsSync but makes readdirSync throw ENOTDIR.
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(path.join(root, 'regression'), '');
    assert.deepEqual(listSavedSuiteResults(), []);
  } finally {
    if (prev === undefined) delete process.env.OUTPUT_ROOT;
    else process.env.OUTPUT_ROOT = prev;
  }
});
