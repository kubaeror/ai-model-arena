import { test } from 'node:test';
import assert from 'node:assert/strict';
import { latencyDetector, loopDetector, costSpikeDetector, type RunAnalysisInput } from '../../src/anomaly-detection/detectors.js';
import type { AnomalyDetectionConfig } from '../../src/anomaly-detection/config.js';
import type { RunHistory } from '../../src/anomaly-detection/baselines.js';
import type { RunResult } from '../../src/logger/result-logger.js';
import type { TraceMeta } from '../../src/observability/trace-meta.js';

function cfg(overrides: Partial<AnomalyDetectionConfig> = {}): AnomalyDetectionConfig {
  return {
    enabled: true,
    slidingWindow: 20,
    minSampleSize: 5,
    latency: { enabled: true, zScoreThreshold: 3, severity: 'high' },
    loop: { enabled: true, consecutiveRepeats: 3, severity: 'medium' },
    tokenSpike: { enabled: true, multiple: 3, severity: 'high' },
    costSpike: { enabled: true, multiple: 3, severity: 'high' },
    errorRate: { enabled: true, zScoreThreshold: 3, severity: 'high' },
    silentFailure: { enabled: true, lowJudgeScore: 40, highJudgeScore: 70, severity: 'medium' },
    ...overrides,
  };
}

function result(partial: Partial<RunResult> = {}): RunResult {
  return {
    model: 'gpt-4o',
    scenario: 'x',
    runId: 'r',
    startedAt: '2026-01-01T00:00:00.000Z',
    finishedAt: '2026-01-01T00:01:00.000Z',
    durationMs: 60000,
    turnsUsed: 3,
    maxTurns: 10,
    totalToolCalls: 0,
    toolsCalled: [],
    tokenUsage: { prompt: 0, completion: 0 },
    errors: [],
    success: true,
    ...partial,
  };
}

function traceWithToolSpan(tool: string, durationMs: number): TraceMeta {
  return {
    traceId: 't', runId: 'r', model: 'gpt-4o', scenario: 'x', modelConfig: 'm',
    spans: [{
      spanId: 's1', parentSpanId: null, traceId: 't', name: tool, type: 'execute_tool',
      startedAt: 0, endedAt: durationMs, durationMs, status: 'ok',
      attributes: { 'gen_ai.tool.name': tool }, events: [],
    }],
    totalDurationMs: durationMs, spanCount: 1, errorCount: 0, externalUrl: null, capturedAt: '',
  };
}

function emptyHistory(): RunHistory {
  return {
    toolLatency: new Map(), tokenTotals: new Map(), costs: new Map(),
    toolErrorRates: new Map(), durations: new Map(),
  };
}

function input(partial: Partial<RunAnalysisInput> = {}): RunAnalysisInput {
  return {
    runId: 'r', model: 'gpt-4o', scenario: 'x', outputDir: '/tmp/x',
    result: null, trace: null, toolCalls: [], judgeScore: null,
    ...partial,
  };
}

test('latency detector flags a run 6σ above history baseline', () => {
  const history = emptyHistory();
  history.toolLatency.set('gpt-4o|shell', [100, 110, 90, 105, 95]);
  const found = latencyDetector(
    input({ trace: traceWithToolSpan('shell', 200) }),
    cfg(),
    history,
  );
  assert.equal(found.length, 1);
  assert.equal(found[0]!.type, 'latency');
  assert.ok(Number(found[0]!.metadata!.zScore) >= 6);
  assert.equal(found[0]!.severity, 'high');
});

test('latency detector stays quiet within 1σ of history baseline', () => {
  const history = emptyHistory();
  history.toolLatency.set('gpt-4o|shell', [100, 110, 90, 105, 95]);
  const found = latencyDetector(
    input({ trace: traceWithToolSpan('shell', 107) }),
    cfg(),
    history,
  );
  assert.equal(found.length, 0);
});

test('loop detector flags 5+ consecutive identical tool calls', () => {
  const toolCalls = Array.from({ length: 5 }, () => ({
    name: 'read_file', turn: 1, success: true, arguments: { path: '/a' },
  }));
  const found = loopDetector(
    input({ toolCalls }),
    cfg({ loop: { enabled: true, consecutiveRepeats: 5, severity: 'medium' } }),
  );
  assert.equal(found.length, 1);
  assert.equal(found[0]!.type, 'loop');
  assert.equal(found[0]!.metadata!.consecutive, 5);
});

test('loop detector stays quiet below the consecutive threshold', () => {
  const toolCalls = Array.from({ length: 4 }, () => ({
    name: 'read_file', turn: 1, success: true, arguments: { path: '/a' },
  }));
  const found = loopDetector(
    input({ toolCalls }),
    cfg({ loop: { enabled: true, consecutiveRepeats: 5, severity: 'medium' } }),
  );
  assert.equal(found.length, 0);
});

test('cost_spike detector flags cost above 5x historical mean', () => {
  const history = emptyHistory();
  history.costs.set('gpt-4o|x', [0.1, 0.1, 0.1, 0.1, 0.1]);
  const found = costSpikeDetector(
    input({ result: result({ costUsd: 0.6 }) }),
    cfg({ costSpike: { enabled: true, multiple: 5, severity: 'high' } }),
    history,
  );
  assert.equal(found.length, 1);
  assert.equal(found[0]!.type, 'cost_spike');
});

test('cost_spike detector stays quiet at or below 5x historical mean', () => {
  const history = emptyHistory();
  history.costs.set('gpt-4o|x', [0.1, 0.1, 0.1, 0.1, 0.1]);
  const found = costSpikeDetector(
    input({ result: result({ costUsd: 0.5 }) }),
    cfg({ costSpike: { enabled: true, multiple: 5, severity: 'high' } }),
    history,
  );
  assert.equal(found.length, 0);
});
