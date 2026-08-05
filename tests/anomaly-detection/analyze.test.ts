import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { initDb, closeDb } from '../../src/db/client.js';
import { upsertRun, type RunIndexRecord } from '../../src/db/runs.js';
import { buildRunHistory, costStats } from '../../src/anomaly-detection/baselines.js';
import { analyzeRun, anomaliesForRun } from '../../src/anomaly-detection/index.js';
import { writeResultJson, type RunResult } from '../../src/logger/result-logger.js';

function mkResult(runId: string, scenario: string, costUsd: number): RunResult {
  return {
    model: 'gpt-4o',
    scenario,
    runId,
    startedAt: '2026-01-01T00:00:00.000Z',
    finishedAt: '2026-01-01T00:01:00.000Z',
    durationMs: 60000,
    turnsUsed: 5,
    maxTurns: 10,
    totalToolCalls: 5,
    toolsCalled: [{ name: 'read_file', count: 5 }],
    tokenUsage: { prompt: 100, completion: 50 },
    errors: [],
    success: true,
    costUsd,
  };
}

function mkRun(runId: string, scenario: string, resultPath: string, startedAt: string): RunIndexRecord {
  return {
    runId, scenario, models: ['gpt-4o'], startedAt,
    finishedAt: startedAt, status: 'completed', source: 'cli',
    perModel: [{
      model: 'gpt-4o', runId, outputDir: path.dirname(resultPath), sandboxDir: '',
      resultPath, conversationPath: '', reportPath: '', logFile: '',
      status: 'completed', success: true,
    }],
    comparisonMdPath: null, comparisonJsonPath: null,
  };
}

test('analyzeRun on the same run twice inserts only one anomaly (dedup)', async () => {
  initDb(':memory:');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arena-anom-dedup-'));
  try {
    const outputDir = path.join(dir, 'out');
    fs.mkdirSync(outputDir, { recursive: true });
    const resultPath = path.join(outputDir, 'result.json');
    writeResultJson(resultPath, mkResult('r-dedup', 'loop-sc', 0.01));

    const conversationPath = path.join(dir, 'conversation.json');
    const repeated = Array.from({ length: 5 }, () => ({ type: 'tool_call', toolName: 'read_file', meta: { args: { path: '/a' } } }));
    fs.writeFileSync(conversationPath, JSON.stringify({
      entries: [
        { type: 'assistant', turn: 1 },
        ...repeated,
        ...Array.from({ length: 5 }, () => ({ type: 'tool_result', toolName: 'read_file' })),
      ],
    }));

    await upsertRun({
      runId: 'r-dedup', scenario: 'loop-sc', models: ['gpt-4o'],
      startedAt: '2026-01-01T00:00:00.000Z', finishedAt: '2026-01-01T00:01:00.000Z',
      status: 'completed', source: 'cli',
      perModel: [{
        model: 'gpt-4o', runId: 'r-dedup', outputDir, sandboxDir: dir,
        resultPath, conversationPath, reportPath: '', logFile: '',
        status: 'completed', success: true,
      }],
      comparisonMdPath: null, comparisonJsonPath: null,
    });

    const first = await analyzeRun('r-dedup');
    const second = await analyzeRun('r-dedup');
    assert.equal(first.length, 1);
    assert.equal(second.length, 1);
    const stored = await anomaliesForRun('r-dedup');
    assert.equal(stored.length, 1);
    assert.equal(stored[0]!.type, 'loop');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    closeDb();
  }
});

test('buildRunHistory(scenario) filters history rows to that scenario', async () => {
  initDb(':memory:');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arena-anom-hist-'));
  try {
    const base = Date.now();
    for (let i = 0; i < 6; i++) {
      const resultPath = path.join(dir, `other-${i}`, 'result.json');
      fs.mkdirSync(path.dirname(resultPath), { recursive: true });
      writeResultJson(resultPath, mkResult(`other-${i}`, 'other-scenario', 0.01));
      await upsertRun(mkRun(`other-${i}`, 'other-scenario', resultPath, new Date(base + (10 + i) * 1000).toISOString()));
    }
    const targetResult = path.join(dir, 'target', 'result.json');
    fs.mkdirSync(path.dirname(targetResult), { recursive: true });
    writeResultJson(targetResult, mkResult('target-run', 'target-scenario', 9.99));
    await upsertRun(mkRun('target-run', 'target-scenario', targetResult, new Date(base).toISOString()));

    const history = await buildRunHistory('gpt-4o', 'target-scenario', 5);
    const target = costStats(history, 'gpt-4o', 'target-scenario');
    assert.equal(target.count, 1);
    assert.equal(target.mean, 9.99);
    const other = costStats(history, 'gpt-4o', 'other-scenario');
    assert.equal(other.count, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    closeDb();
  }
});
